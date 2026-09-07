// @ts-check
/**
 * The normalized event model every mode emits, plus the text accumulator that
 * hides the three streaming shapes we have observed:
 *
 *   - delta fragments        (Copilot SDK assistant.message_delta; Agent Framework
 *                             CopilotStudioAgent typing updates)
 *   - cumulative snapshots   (Copilot Studio client library typing activities
 *                             with channelData.streamType = "streaming")
 *   - final-only             (no-auth agentic Direct Line: one message, no chunks)
 *
 * Every text event carries BOTH `delta` and `snapshot`, so a caller can render
 * either way without caring which shape the wire used.
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
  }

  /**
   * Feed a chunk of text. Returns the delta that was appended.
   * A chunk that starts with the current snapshot is treated as a cumulative
   * snapshot (delta = the new suffix); anything else is treated as a fragment
   * and appended.
   * @param {string} text
   * @param {{ mode?: 'delta' | 'cumulative' | 'auto' }} [opts]
   */
  push(text, opts = {}) {
    const mode = opts.mode || 'auto';
    const incoming = String(text ?? '');
    this.chunks += 1;
    if (mode === 'delta') {
      this.shape = 'delta';
      this.snapshot += incoming;
      return incoming;
    }
    if (mode === 'cumulative' || (this.snapshot && incoming.startsWith(this.snapshot))) {
      this.shape = 'cumulative';
      const delta = incoming.slice(this.snapshot.length);
      this.snapshot = incoming;
      return delta;
    }
    if (!this.snapshot) {
      // First chunk: shape still unknown; both interpretations agree.
      this.snapshot = incoming;
      return incoming;
    }
    this.shape = 'delta';
    this.snapshot += incoming;
    return incoming;
  }

  /**
   * Finalize with the complete text. Returns the trailing delta (if any).
   * @param {string} text
   */
  finalize(text) {
    const finalText = String(text ?? this.snapshot);
    const delta = finalText.startsWith(this.snapshot) ? finalText.slice(this.snapshot.length) : '';
    this.snapshot = finalText;
    return delta;
  }
}

/**
 * Maps one Copilot Studio activity (client library `Activity`, plain object
 * accepted) onto normalized events. `acc` carries text state across the turn.
 *
 * Wire facts this encodes (README "How livestreaming works"):
 *   - typing + channelData.streamType "informative"  → status
 *   - typing + channelData.streamType "streaming"    → text.delta (cumulative snapshot on the Node client)
 *   - message + channelData.streamType "final"       → text.final
 *   - message without streamType                      → text.final (final-only agents)
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
  const base = { source: 'copilot-studio', raw: activity };

  if (activity?.type === 'typing') {
    if (streamType === 'informative') {
      out.push({ type: 'status', text, ...base });
    } else if (streamType === 'streaming' && text) {
      const delta = acc.push(text);
      out.push({ type: 'text.delta', delta, snapshot: acc.snapshot, sequence: cd.streamSequence, streamId: cd.streamId, ...base });
    } else if (text) {
      // Typing with text but no streamType: treat as a fragment (Agent Framework shape).
      const delta = acc.push(text);
      out.push({ type: 'text.delta', delta, snapshot: acc.snapshot, sequence: cd.streamSequence, streamId: cd.streamId, ...base });
    } else {
      out.push({ type: 'raw', ...base });
    }
    return out;
  }

  if (activity?.type === 'message') {
    const delta = acc.finalize(text);
    if (delta) {
      out.push({ type: 'text.delta', delta, snapshot: acc.snapshot, sequence: cd.streamSequence, streamId: cd.streamId, ...base });
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
 * A tiny async queue so callbacks can feed an async iterator.
 * @template T
 */
export function createEventQueue() {
  /** @type {T[]} */
  const buffer = [];
  /** @type {((v: IteratorResult<T>) => void) | null} */
  let waiter = null;
  let done = false;
  /** @type {Error | null} */
  let failure = null;

  return {
    /** @param {T} item */
    push(item) {
      if (done) return;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: item, done: false });
      } else {
        buffer.push(item);
      }
    },
    /** @param {Error} [err] */
    close(err) {
      if (done) return;
      done = true;
      failure = err || null;
      if (waiter) {
        const w = waiter;
        waiter = null;
        if (failure) {
          // Surface as a rejected next() by pushing a sentinel the iterator throws on.
          w({ value: /** @type {any} */ ({ __error: failure }), done: false });
        } else {
          w({ value: undefined, done: true });
        }
      }
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
          const result = await new Promise((resolve) => {
            waiter = resolve;
          });
          const v = /** @type {any} */ (result.value);
          if (v && v.__error) throw v.__error;
          return result;
        },
        async return() {
          self.close();
          return { value: undefined, done: true };
        }
      };
    }
  };
}
