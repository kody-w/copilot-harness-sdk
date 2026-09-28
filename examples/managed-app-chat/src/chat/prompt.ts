import type { Message } from './store'

/**
 * The Agents connector starts a new agent run for every message, so earlier turns
 * travel with the new one. Newest turns are kept when the history is too long.
 */
export function buildPrompt(history: Message[], text: string, limits: { turns: number; chars: number }): string {
  const earlier = history.filter((message) => !message.failed).slice(-limits.turns * 2)
  const lines: string[] = []
  let used = 0
  for (let i = earlier.length - 1; i >= 0; i--) {
    const message = earlier[i]
    const line = `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text.trim()}`
    if (used + line.length > limits.chars) break
    lines.unshift(line)
    used += line.length
  }
  if (!lines.length) return text
  return ['Earlier in this conversation:', ...lines, '', 'Answer this new message, using the conversation above only as context:', text].join('\n')
}
