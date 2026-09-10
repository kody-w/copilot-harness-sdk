// @ts-check
/**
 * The normalized event model every mode emits, plus the text accumulator that
 * hides the three streaming shapes we have observed:
 *
 *   - delta fragments        (Copilot SDK assistant.message_delta; Agent Framework
 *                             CopilotStudioAgent typing updates)
 *   - cumulative snapshots   (Copilot Studio client library typing activities
 *                             with channelData.streamType = "streaming"; the
 *                             library joins chunks by streamSequence, so a
 *                             snapshot is not always a prefix-extension)
 *   - final-only             (no-auth agentic Direct Line: one message, no chunks)
 *
 * Every text event carries BOTH `delta` and `snapshot`. `snapshot` is the
 * authoritative full text so far; `delta` is best-effort and is '' when a
 * cumulative snapshot replaced rather than extended the previous one
 * (`replaced: true` on the event).
 */

/** @typedef {import('../index.js').HarnessEvent} HarnessEvent */

/**
 * Accumulates streamed text and classifies each incoming chunk.
 */
export class TextAccumulator {
  constructor() {
    /** @type {string} */
    this.snapshot = '';
    /** @type {'unknown' | 'delta' | 'cumulative'} */
    this.shape = 'unknown';
    this.chunks = 0;
    /** Set when the last cumulative push replaced (not extended) the snapshot. */
    this.lastReplaced = false;
    /** The stream this accumulator is currently tracking (Copilot Studio streamId). */
    this.streamId = undefined;
    /** True after finalize(); the next chunk starts a new stream. */
    this.finalized = false;
  }

  reset() {
    this.snapshot = '';
    this.shape = 'unknown';
    this.chunks = 0;
    this.lastReplaced = false;
    this.streamId = undefined;
    this.finalized = false;
  }

  /**
   * Feed a chunk of text. Returns the delta that was appended.
   * - mode 'delta': append.
   * - mode 'cumulative': the chunk is the full text so far; delta is the new
   *   suffix, or '' (with lastReplaced=true) when it does not extend the previous snapshot.
   * - mode 'auto': a chunk that starts with the current snapshot is cumulative,
   *   anything else is a fragment.
   * @param {string} text
   * @param {{ mode?: 'delta' | 'cumulative' | 'auto', streamId?: string }} [opts]
   */
  push(text, opts = {}) {
    const mode = opts.mode || 'auto';
    const incoming = String(text ?? '');
    if (this.finalized || (opts.streamId !== undefined && this.streamId !== undefined && opts.streamId !== this.streamId)) {
      this.reset();
    }
    if (opts.streamId !== undefined) this.streamId = opts.streamId;
    this.chunks += 1;
    this.lastReplaced = false;
    if (mode === 'delta') {
      this.shape = 'delta';
      this.snapshot += incoming;
      return incoming;
    }
    if (mode === 'cumulative') {
      this.shape = 'cumulative';
      if (incoming.startsWith(this.snapshot)) {
        const delta = incoming.slice(this.snapshot.length);
        this.snapshot = incoming;
        return delta;
      }
      this.lastReplaced = true;
      this.snapshot = incoming;
      return '';
    }
    if (this.snapshot && incoming.startsWith(this.snapshot)) {
      this.shape = 'cumulative';
      const delta = incoming.slice(this.snapshot.length);
      this.snapshot = incoming;
      return delta;
    }
    if (!this.snapshot) {
      this.snapshot = incoming;
      return incoming;
    }
    this.shape = 'delta';
    this.snapshot += incoming;
    return incoming;
  }

  /**
   * Finalize with the complete text. An empty/undefined text keeps the current
   * snapshot (a card-only message must not wipe the streamed answer). Returns
   * the trailing delta (if any).
   * @param {string | undefined} text
   */
  finalize(text) {
    const finalText = text ? String(text) : this.snapshot;
    const delta = finalText.startsWith(this.snapshot) ? finalText.slice(this.snapshot.length) : '';
    this.snapshot = finalText;
    this.finalized = true;
    return delta;
  }
}

/**
 * Maps one Copilot Studio activity (client library `Activity`, plain object
 * accepted) onto normalized events. `acc` carries text state across the turn.
 *
 * Wire facts this encodes (playground README "How livestreaming works"):
 *   - typing + channelData.streamType "informative"  → status
 *   - typing + channelData.streamType "streaming"    → text.delta (cumulative snapshot from the Node client)
 *   - typing with text and no streamType             → text.delta (auto-detected shape)
 *   - message + channelData.streamType "final"       → text.final
 *   - message without streamType                      → text.final (final-only agents)
 *   - message without text (card / attachments only)  → text.final keeping the streamed text
 *   - event activities                                → raw (turn.complete, startConversation, etc.)
 *
 * @param {any} activity
 * @param {TextAccumulator} acc
 * @returns {HarnessEvent[]}
 */
export function normalizeStudioActivity(activity, acc) {
  const out = [];
  const cd = activity?.channelData || {};
  const streamType = cd.streamType;
  const text = typeof activity?.text === 'string' ? activity.text : '';
  const base = { source: /** @type {const} */ ('copilot-studio'), raw: activity };

  if (activity?.type === 'typing') {
    if (streamType === 'informative') {
      out.push({ type: 'status', text, ...base });
    } else if (streamType === 'streaming' && text) {
      const delta = acc.push(text, { mode: 'cumulative', streamId: cd.streamId });
      out.push({ type: 'text.delta', delta, snapshot: acc.snapshot, replaced: acc.lastReplaced, sequence: cd.streamSequence, streamId: cd.streamId, ...base });
    } else if (text) {
      const delta = acc.push(text, { streamId: cd.streamId });
      out.push({ type: 'text.delta', delta, snapshot: acc.snapshot, replaced: acc.lastReplaced, sequence: cd.streamSequence, streamId: cd.streamId, ...base });
    } else {
      out.push({ type: 'raw', ...base });
    }
    return out;
  }

  if (activity?.type === 'message') {
    if (text && cd.streamId !== undefined && acc.streamId !== undefined && cd.streamId !== acc.streamId && !acc.finalized) {
      // A final for a different stream than the one being accumulated: start fresh.
      acc.reset();
    }
    const delta = acc.finalize(text);
    if (delta) {
      out.push({ type: 'text.delta', delta, snapshot: acc.snapshot, replaced: false, sequence: cd.streamSequence, streamId: cd.streamId, ...base });
    }
    out.push({
      type: 'text.final',
      text: acc.snapshot,
      streamId: cd.streamId,
      attachments: Array.isArray(activity.attachments) ? activity.attachments : [],
      suggestedActions: activity.suggestedActions?.actions || [],
      ...base
    });
    return out;
  }

  out.push({ type: 'raw', ...base });
  return out;
}

/**
 * Call every listener, isolating throws so one bad subscriber cannot break
 * the stream or starve the others. Errors are reported via `onListenerError`.
 * @param {Iterable<(event: HarnessEvent) => void>} listeners
 * @param {HarnessEvent} event
 * @param {(err: unknown, event: HarnessEvent) => void} [onListenerError]
 */
export function safeEmit(listeners, event, onListenerError) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      if (onListenerError) onListenerError(err, event);
    }
  }
}

/**
 * A tiny async queue so callbacks can feed an async iterator.
 * - FIFO waiters: concurrent next() calls all settle, in order.
 * - close(err) rejects exactly one pending/next call with err, then ends.
 * - return() (early break) calls `onReturn` so the producer can clean up.
 * @template T
 * @param {{ onReturn?: () => void }} [opts]
 */
export function createEventQueue(opts = {}) {
  /** @type {T[]} */
  const buffer = [];
  /** @type {Array<{ resolve: (v: IteratorResult<T>) => void, reject: (e: Error) => void }>} */
  const waiters = [];
  let done = false;
  /** @type {Error | null} */
  let failure = null;

  return {
    /** @param {T} item */
    push(item) {
      if (done) return;
      const w = waiters.shift();
      if (w) w.resolve({ value: item, done: false });
      else buffer.push(item);
    },
    /** @param {Error} [err] */
    close(err) {
      if (done) return;
      done = true;
      if (err) {
        const w = waiters.shift();
        if (w) w.reject(err);
        else failure = err;
      }
      for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true });
    },
    get closed() {
      return done;
    },
    /** @returns {AsyncIterableIterator<T>} */
    iterator() {
      const self = this;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (buffer.length) return { value: /** @type {T} */ (buffer.shift()), done: false };
          if (done) {
            if (failure) {
              const e = failure;
              failure = null;
              throw e;
            }
            return { value: undefined, done: true };
          }
          return new Promise((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        async return() {
          if (!done) {
            try {
              opts.onReturn?.();
            } finally {
              self.close();
            }
          }
          return { value: undefined, done: true };
        }
      };
    }
  };
}
