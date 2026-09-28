// Conversations are kept in the browser. If the player does not allow storage they last until the page closes.

export interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  /** Assistant messages: how long the answer took. */
  seconds?: number
  /** Assistant messages that are a failure notice, not an answer. */
  failed?: boolean
  detail?: string
}

export interface Conversation {
  id: string
  title: string
  agentId: string
  agentName: string
  createdAt: number
  updatedAt: number
  messages: Message[]
}

export interface Saved {
  conversations: Conversation[]
  theme?: 'light' | 'dark'
  agent?: { agentId: string; agentName: string }
}

const KEY = 'harness-chat:v1'
let memory: Saved = { conversations: [] }
let persistent = true

export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export function load(): Saved {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Saved
      if (parsed && Array.isArray(parsed.conversations)) memory = parsed
    }
  } catch {
    persistent = false
  }
  return memory
}

export function save(next: Saved): void {
  memory = next
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    persistent = false
  }
}

/** False when the browser refused storage: chats then last only while the page is open. */
export const isPersistent = () => persistent

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New chat'
}

export function toMarkdown(conversation: Conversation): string {
  const lines = [`# ${conversation.title}`, '', `${conversation.agentName} · ${new Date(conversation.createdAt).toLocaleString()}`, '']
  for (const message of conversation.messages) {
    lines.push(message.role === 'user' ? '## You' : `## ${conversation.agentName}`, '', message.text, '')
  }
  return lines.join('\n')
}
