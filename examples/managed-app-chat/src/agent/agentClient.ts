// Ask a Copilot Studio agent a question through the Agents connector and wait for its answer.
import { getClient } from '@microsoft/managed-apps/data'
import { AGENT_DATA_SOURCE, agentDataSources } from './dataSource'

export interface AgentChoice {
  agentId: string
  agentName: string
}

export interface AgentAnswer {
  text: string
  conversationId: string
  route: string
  seconds: number
}

/** What went wrong, in words for the person, with the technical detail kept apart. */
export class AgentError extends Error {
  readonly detail: string
  readonly stopped: boolean
  constructor(message: string, detail = '', stopped = false) {
    super(message)
    this.name = 'AgentError'
    this.detail = detail
    this.stopped = stopped
  }
}

interface Route {
  name: string
  invoke: string
  status: string
  cancel: string
}

// Published agents first (the route the GitHub Copilot harness uses); the listed action second.
const ROUTES: Route[] = [
  { name: 'published', invoke: 'InvokeAgent_V2', status: 'GetConversationStatus_V2', cancel: 'CancelConversation_V2' },
  { name: 'standard', invoke: 'InvokeAgent', status: 'GetConversationStatus', cancel: 'CancelConversation' },
]

interface Failure {
  message: string
  status?: number
}

interface RunState {
  conversationId?: string
  status?: string
  result?: string
  error?: unknown
  message?: string
}

const client = getClient(agentDataSources)
let preferred = 0

async function call<T>(operationName: string, parameters: Record<string, unknown>): Promise<{ data?: T; failure?: Failure }> {
  const result = await client.executeAsync<Record<string, unknown>, T>({
    connectorOperation: { tableName: AGENT_DATA_SOURCE, operationName, parameters },
  })
  if (result.success) return { data: result.data }
  const error = result.error as { message?: string; status?: number } | undefined
  return { failure: { message: error?.message || 'The connector did not answer.', status: error?.status } }
}

// Browsers slow the timers of a hidden tab, down to one a minute. Waking on return to the tab
// means an answer that finished while the person looked elsewhere shows as soon as they are back.
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    const onVisible = () => {
      if (document.visibilityState === 'visible') done()
    }
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      document.removeEventListener('visibilitychange', onVisible)
      resolve()
    }
    signal?.addEventListener('abort', done)
    document.addEventListener('visibilitychange', onVisible)
  })

const stillRunning = (status: string | undefined) =>
  !status || /progress|running|queued|pending|notstarted|waiting|accepted/i.test(status)

function describe(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export async function askAgent(
  agentId: string,
  prompt: string,
  options: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number } = {},
): Promise<AgentAnswer> {
  const { signal, timeoutMs = 5 * 60_000, pollMs = 2500 } = options
  const started = Date.now()
  const seconds = () => Math.round((Date.now() - started) / 1000)

  let route = ROUTES[preferred]
  let first = await call<RunState>(route.invoke, { body: { agentId, prompt } })
  if (first.failure && preferred === 0 && first.failure.status !== undefined && first.failure.status >= 400 && first.failure.status < 500) {
    // The published route was refused: try the action the connector lists.
    route = ROUTES[1]
    const second = await call<RunState>(route.invoke, { body: { agentId, prompt } })
    if (!second.failure) preferred = 1
    first = second.failure ? first : second
  }
  if (first.failure) {
    throw new AgentError('I could not reach the agent. Please try again.', `${route.invoke}: ${first.failure.status ?? ''} ${first.failure.message}`.trim())
  }

  let state: RunState = first.data ?? {}
  const conversationId = state.conversationId
  if (!conversationId) {
    // Some runs answer in one step.
    if (state.result && !stillRunning(state.status)) return { text: state.result, conversationId: '', route: route.name, seconds: seconds() }
    throw new AgentError('The agent did not start. Please try again.', `${route.invoke} returned no conversation id: ${describe(state)}`)
  }

  let misses = 0
  while (stillRunning(state.status)) {
    if (signal?.aborted) {
      void call(route.cancel, { conversationId })
      throw new AgentError('Stopped.', '', true)
    }
    if (Date.now() - started > timeoutMs) {
      void call(route.cancel, { conversationId })
      throw new AgentError('The agent is taking too long. Please try again.', `No answer after ${seconds()} seconds (conversation ${conversationId}).`)
    }
    await wait(pollMs, signal)
    if (signal?.aborted) continue
    const next = await call<RunState>(route.status, { conversationId })
    if (next.failure) {
      // One missed check is not a failed run.
      misses += 1
      if (misses >= 4) {
        throw new AgentError('I lost contact with the agent. Please try again.', `${route.status}: ${next.failure.status ?? ''} ${next.failure.message}`.trim())
      }
      continue
    }
    misses = 0
    state = next.data ?? {}
  }

  if (/complete|succe/i.test(state.status ?? '') && state.result) {
    return { text: state.result, conversationId, route: route.name, seconds: seconds() }
  }
  if (/complete|succe/i.test(state.status ?? '')) {
    throw new AgentError('The agent finished without an answer. Try asking in a different way.', `Status ${state.status}, empty result (conversation ${conversationId}).`)
  }
  throw new AgentError('The agent could not finish. Please try again.', `Status ${state.status}: ${describe(state.error ?? state.message ?? state.result)} (conversation ${conversationId}).`)
}

/** The agents this connection can run, by name. */
export async function listAgents(): Promise<AgentChoice[]> {
  const result = await call<{ agents?: AgentChoice[] }>('ListAgents', {})
  if (result.failure) throw new AgentError('I could not read the list of agents.', `ListAgents: ${result.failure.status ?? ''} ${result.failure.message}`.trim())
  return (result.data?.agents ?? [])
    .filter((agent) => agent && typeof agent.agentId === 'string')
    .map((agent) => ({ agentId: agent.agentId, agentName: agent.agentName || agent.agentId }))
    .sort((a, b) => a.agentName.localeCompare(b.agentName))
}
