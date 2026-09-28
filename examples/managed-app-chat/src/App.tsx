import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import './App.css'
import { AgentError, askAgent, listAgents } from './agent/agentClient'
import type { AgentChoice } from './agent/agentClient'
import { BUILD } from './build'
import { Markdown } from './chat/Markdown'
import { buildPrompt } from './chat/prompt'
import { isPersistent, load, newId, save, titleFrom, toMarkdown } from './chat/store'
import type { Conversation, Message, Saved } from './chat/store'
import { CONFIG } from './config'

type Theme = 'light' | 'dark'

const systemTheme = (): Theme =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

function Icon({ name }: { name: 'spark' | 'plus' | 'search' | 'chat' | 'send' | 'stop' | 'export' | 'trash' | 'theme' | 'menu' | 'close' }) {
  const paths: Record<string, string> = {
    spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z',
    plus: 'M12 5v14M5 12h14',
    search: 'M11 4a7 7 0 105 11.9l4 4M11 4a7 7 0 010 14',
    chat: 'M4 5h16v11H9l-5 4V5z',
    send: 'M4 12l16-8-6 16-3-7-7-1z',
    stop: 'M7 7h10v10H7z',
    export: 'M12 4v11m0 0l-4-4m4 4l4-4M5 19h14',
    trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
    theme: 'M12 3a9 9 0 100 18c1 0 1.5-.8 1.5-1.5 0-1.5 1-2 2.5-2H18a3 3 0 003-3c0-6-4-11.5-9-11.5z',
    menu: 'M4 7h16M4 12h16M4 17h16',
    close: 'M6 6l12 12M18 6L6 18',
  }
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name]} />
    </svg>
  )
}

export default function App() {
  const [saved, setSaved] = useState<Saved>(() => load())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [working, setWorking] = useState<{ conversationId: string; since: number } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [notice, setNotice] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [agents, setAgents] = useState<AgentChoice[] | null>(null)
  const [agentsState, setAgentsState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [lastRoute, setLastRoute] = useState('')
  const stopper = useRef<AbortController | null>(null)
  const bottom = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLTextAreaElement | null>(null)

  const theme: Theme = saved.theme ?? systemTheme()
  const agent = saved.agent ?? { agentId: CONFIG.agentId, agentName: CONFIG.agentName }
  const active = useMemo(() => saved.conversations.find((c) => c.id === activeId) ?? null, [saved, activeId])
  const busy = working !== null
  const busyHere = busy && working.conversationId === activeId

  const update = useCallback((change: (current: Saved) => Saved) => {
    setSaved((current) => {
      const next = change(current)
      save(next)
      return next
    })
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.title = CONFIG.appName
  }, [theme])

  useEffect(() => {
    if (!working) return
    setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - working.since) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [working])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [active?.messages.length, busyHere])

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    const list = [...saved.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!term) return list
    return list.filter((c) => c.title.toLowerCase().includes(term) || c.messages.some((m) => m.text.toLowerCase().includes(term)))
  }, [saved.conversations, search])

  const send = useCallback(
    async (text: string) => {
      const question = text.trim()
      if (!question || busy) return
      setNotice('')
      setDraft('')
      const now = Date.now()
      const existing = saved.conversations.find((c) => c.id === activeId)
      const conversation: Conversation = existing ?? {
        id: newId(),
        title: titleFrom(question),
        agentId: agent.agentId,
        agentName: agent.agentName,
        createdAt: now,
        updatedAt: now,
        messages: [],
      }
      const history = conversation.messages
      const asked: Message = { id: newId(), role: 'user', text: question, at: now }
      const withQuestion: Conversation = { ...conversation, updatedAt: now, messages: [...history, asked] }
      update((current) => ({
        ...current,
        conversations: existing ? current.conversations.map((c) => (c.id === conversation.id ? withQuestion : c)) : [withQuestion, ...current.conversations],
      }))
      setActiveId(conversation.id)
      setWorking({ conversationId: conversation.id, since: now })
      const controller = new AbortController()
      stopper.current = controller

      let reply: Message
      try {
        const answer = await askAgent(conversation.agentId, buildPrompt(history, question, { turns: CONFIG.memoryTurns, chars: CONFIG.memoryChars }), {
          signal: controller.signal,
          timeoutMs: CONFIG.answerTimeoutMs,
        })
        setLastRoute(answer.route)
        reply = { id: newId(), role: 'assistant', text: answer.text, at: Date.now(), seconds: answer.seconds }
      } catch (error) {
        const known = error instanceof AgentError ? error : new AgentError('Something went wrong. Please try again.', String(error))
        reply = { id: newId(), role: 'assistant', text: known.message, at: Date.now(), failed: true, detail: known.detail }
      }
      update((current) => ({
        ...current,
        conversations: current.conversations.map((c) => (c.id === conversation.id ? { ...c, updatedAt: Date.now(), messages: [...c.messages, reply] } : c)),
      }))
      stopper.current = null
      setWorking(null)
      input.current?.focus()
    },
    [activeId, agent.agentId, agent.agentName, busy, saved.conversations, update],
  )

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void send(draft)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send(draft)
    }
  }

  const newChat = () => {
    setActiveId(null)
    setDraft('')
    setNotice('')
    setMenuOpen(false)
    input.current?.focus()
  }

  const clearAll = () => {
    if (busy) return
    update((current) => ({ ...current, conversations: [] }))
    setActiveId(null)
    setNotice('All conversations cleared.')
  }

  const exportChat = async () => {
    if (!active) return
    const text = toMarkdown(active)
    try {
      const link = document.createElement('a')
      link.href = `data:text/markdown;charset=utf-8,${encodeURIComponent(text)}`
      link.download = `${active.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 50) || 'chat'}.md`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setNotice('Saved to your downloads.')
    } catch {
      try {
        await navigator.clipboard.writeText(text)
        setNotice('Copied to your clipboard.')
      } catch {
        setNotice('This chat could not be exported here.')
      }
    }
  }

  const openDetails = async () => {
    setDetailsOpen(true)
    if (agents || agentsState === 'loading') return
    setAgentsState('loading')
    try {
      setAgents(await listAgents())
      setAgentsState('idle')
    } catch {
      setAgentsState('error')
    }
  }

  const chooseAgent = (agentId: string) => {
    const choice = agents?.find((a) => a.agentId === agentId)
    if (!choice) return
    update((current) => ({ ...current, agent: choice }))
    setActiveId(null)
  }

  const state = busyHere ? 'working' : active?.messages.at(-1)?.failed ? 'error' : active ? 'ready' : 'idle'
  const shownAgent = active ? active.agentName : agent.agentName

  return (
    <div className={`app${menuOpen ? ' menu-open' : ''}`} data-build={BUILD}>
      <aside className="side" aria-label="Conversations">
        <div className="brand">
          <span className="logo">
            <Icon name="spark" />
          </span>
          <span>
            <strong>{CONFIG.appName}</strong>
            <small>{CONFIG.tagline}</small>
          </span>
        </div>
        <button type="button" className="primary" onClick={newChat} data-testid="new-chat">
          <Icon name="plus" />
          New chat
        </button>
        <label className="search">
          <Icon name="search" />
          <input type="search" placeholder="Search chats…" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="search" aria-label="Search chats" />
        </label>
        <nav className="chats" data-testid="chat-list" data-count={visible.length}>
          {visible.length === 0 && <p className="hint">{saved.conversations.length ? 'No chats match.' : 'No conversations yet. Start a new chat to begin.'}</p>}
          {visible.map((c) => (
            <button
              type="button"
              key={c.id}
              className={c.id === activeId ? 'chat current' : 'chat'}
              onClick={() => {
                setActiveId(c.id)
                setMenuOpen(false)
              }}
              title={c.title}
            >
              <Icon name="chat" />
              <span>{c.title}</span>
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <button type="button" className="row" onClick={() => update((current) => ({ ...current, theme: theme === 'dark' ? 'light' : 'dark' }))} data-testid="theme">
            <Icon name="theme" />
            <span>Theme</span>
            <i className="swatch" aria-hidden="true" />
          </button>
          <button type="button" className="row quiet" onClick={clearAll} disabled={busy || saved.conversations.length === 0} data-testid="clear">
            <Icon name="trash" />
            <span>Clear all conversations</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="top">
          <button type="button" className="ghost menu" onClick={() => setMenuOpen((open) => !open)} aria-label="Conversations">
            <Icon name={menuOpen ? 'close' : 'menu'} />
          </button>
          <div className="title">
            <strong data-testid="title">{active ? active.title : CONFIG.appName}</strong>
            <small>Powered by {shownAgent}</small>
          </div>
          <button type="button" className="ghost" onClick={() => void openDetails()} data-testid="details">
            Details
          </button>
          <button type="button" className="outline" onClick={() => void exportChat()} disabled={!active || active.messages.length === 0} data-testid="export">
            <Icon name="export" />
            <span>Export</span>
          </button>
        </header>

        <section className="thread" data-testid="messages" data-count={active?.messages.length ?? 0} aria-live="polite">
          {!active && (
            <div className="welcome">
              <span className="logo big">
                <Icon name="spark" />
              </span>
              <h1>How can I help today?</h1>
              <p>Ask anything. Your conversation is saved {isPersistent() ? 'automatically' : 'until you close this page'}.</p>
              <div className="starters">
                {CONFIG.starters.map((starter) => (
                  <button type="button" key={starter} onClick={() => void send(starter)} disabled={busy} data-testid="starter">
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}
          {active?.messages.map((message) =>
            message.role === 'user' ? (
              <div className="turn mine" key={message.id} data-testid="question">
                <div className="bubble">{message.text}</div>
              </div>
            ) : (
              <div className={message.failed ? 'turn theirs failed' : 'turn theirs'} key={message.id} data-testid={message.failed ? 'failure' : 'answer'}>
                <span className="avatar">
                  <Icon name="spark" />
                </span>
                <div className="bubble">
                  {message.failed ? <p>{message.text}</p> : <Markdown text={message.text} />}
                  {message.failed && message.detail && (
                    <details>
                      <summary>Details</summary>
                      <code>{message.detail}</code>
                    </details>
                  )}
                </div>
              </div>
            ),
          )}
          {busyHere && (
            <div className="turn theirs" data-testid="working">
              <span className="avatar">
                <Icon name="spark" />
              </span>
              <div className="bubble waiting">
                <span className="dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span>
                  {shownAgent} is working on it{elapsed >= 3 ? ` · ${elapsed}s` : ''}
                </span>
              </div>
            </div>
          )}
          <div ref={bottom} />
        </section>

        <footer className="compose">
          {notice && (
            <p className="notice" role="status" data-testid="notice">
              {notice}
            </p>
          )}
          <form onSubmit={onSubmit}>
            <textarea
              ref={input}
              rows={1}
              placeholder="Message the assistant…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              data-testid="composer"
              aria-label="Message"
            />
            {busy ? (
              <button type="button" className="send" onClick={() => stopper.current?.abort()} aria-label="Stop" data-testid="stop">
                <Icon name="stop" />
              </button>
            ) : (
              <button type="submit" className="send" disabled={!draft.trim()} aria-label="Send" data-testid="send">
                <Icon name="send" />
              </button>
            )}
          </form>
          <small>Press Enter to send · Shift+Enter for a new line</small>
        </footer>
        <span hidden data-testid="status" data-state={state} data-build={BUILD} data-route={lastRoute} />
      </main>

      {detailsOpen && (
        <div className="sheet" role="dialog" aria-label="Details" data-testid="details-sheet">
          <div className="sheet-body">
            <header>
              <strong>Details</strong>
              <button type="button" className="ghost" onClick={() => setDetailsOpen(false)} aria-label="Close">
                <Icon name="close" />
              </button>
            </header>
            <label>
              Agent for new chats
              {agentsState === 'loading' && <p className="hint">Reading the list of agents…</p>}
              {agentsState === 'error' && <p className="hint">The list of agents could not be read. New chats keep using {agent.agentName}.</p>}
              {agents && (
                <select value={agent.agentId} onChange={(e) => chooseAgent(e.target.value)} data-testid="agent-picker" data-count={agents.length}>
                  {!agents.some((a) => a.agentId === agent.agentId) && <option value={agent.agentId}>{agent.agentName}</option>}
                  {agents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {a.agentName}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <dl>
              <dt>Agent id</dt>
              <dd>{agent.agentId}</dd>
              <dt>Connection</dt>
              <dd>Agents connector{lastRoute ? ` (${lastRoute} route)` : ''}</dd>
              <dt>Memory</dt>
              <dd>The last {CONFIG.memoryTurns} turns travel with each message.</dd>
              <dt>Build</dt>
              <dd>{BUILD}</dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  )
}
