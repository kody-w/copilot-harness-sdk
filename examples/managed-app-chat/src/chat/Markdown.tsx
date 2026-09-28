// A small Markdown renderer for agent answers: headings, lists, tables, code, quotes, links.
// It builds React elements only, so nothing an agent writes is ever treated as HTML.
import { Fragment } from 'react'
import type { ReactNode } from 'react'

const INLINE =
  /(`[^`\n]+`)|(\*\*[^\n]+?\*\*)|(__[^_\n]+?__)|(~~[^~\n]+?~~)|(\*[^*\s][^*\n]*?\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"])/g

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    if (at > last) out.push(text.slice(last, at))
    const token = match[0]
    const key = `${keyPrefix}-${n++}`
    if (match[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>)
    else if (match[2] || match[3]) out.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>)
    else if (match[4]) out.push(<del key={key}>{inline(token.slice(2, -2), key)}</del>)
    else if (match[5]) out.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>)
    else if (match[6]) {
      const split = token.lastIndexOf('](')
      out.push(
        <a key={key} href={token.slice(split + 2, -1)} target="_blank" rel="noopener noreferrer">
          {inline(token.slice(1, split), key)}
        </a>,
      )
    } else {
      out.push(
        <a key={key} href={token} target="_blank" rel="noopener noreferrer">
          {token}
        </a>,
      )
    }
    last = at + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function lines(text: string, keyPrefix: string): ReactNode[] {
  return text.split('\n').map((line, i) => (
    <Fragment key={`${keyPrefix}-l${i}`}>
      {i > 0 && <br />}
      {inline(line, `${keyPrefix}-l${i}`)}
    </Fragment>
  ))
}

const FENCE = /^\s*(```|~~~)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())

function blocks(source: string[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  let n = 0
  const key = () => `${keyPrefix}-b${n++}`

  while (i < source.length) {
    const line = source[i]
    if (!line.trim()) {
      i += 1
      continue
    }

    const fence = line.match(FENCE)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < source.length && !source[i].trim().startsWith(fence[1])) body.push(source[i++])
      i += 1
      out.push(
        <pre key={key()}>
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      const k = key()
      const level = Math.min(heading[1].length + 1, 6)
      const content = inline(heading[2], k)
      out.push(level === 2 ? <h2 key={k}>{content}</h2> : level === 3 ? <h3 key={k}>{content}</h3> : <h4 key={k}>{content}</h4>)
      i += 1
      continue
    }

    if (RULE.test(line)) {
      out.push(<hr key={key()} />)
      i += 1
      continue
    }

    if (line.includes('|') && i + 1 < source.length && TABLE_RULE.test(source[i + 1]) && source[i + 1].includes('-')) {
      const k = key()
      const head = cells(line)
      const rows: string[][] = []
      i += 2
      while (i < source.length && source[i].includes('|') && source[i].trim()) rows.push(cells(source[i++]))
      out.push(
        <div className="table-wrap" key={k}>
          <table>
            <thead>
              <tr>
                {head.map((cell, c) => (
                  <th key={c}>{inline(cell, `${k}-h${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {head.map((_, c) => (
                    <td key={c}>{inline(row[c] ?? '', `${k}-r${r}c${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < source.length && QUOTE.test(source[i])) body.push(source[i++].replace(QUOTE, '$1'))
      const k = key()
      out.push(<blockquote key={k}>{blocks(body, k)}</blockquote>)
      continue
    }

    const item = line.match(ITEM)
    if (item) {
      const k = key()
      const indent = item[1].length
      const ordered = /\d/.test(item[2])
      const items: { text: string; children: string[] }[] = []
      while (i < source.length) {
        const current = source[i]
        const next = current.match(ITEM)
        if (next && next[1].length <= indent + 1 && /\d/.test(next[2]) === ordered) {
          items.push({ text: next[3], children: [] })
          i += 1
        } else if (items.length && current.trim() && /^\s{2,}/.test(current)) {
          items[items.length - 1].children.push(current.replace(/^\s{2,4}/, ''))
          i += 1
        } else if (items.length && !current.trim() && i + 1 < source.length && (ITEM.test(source[i + 1]) || /^\s{2,}\S/.test(source[i + 1]))) {
          i += 1
        } else break
      }
      const rendered = items.map((entry, e) => (
        <li key={e}>
          {inline(entry.text, `${k}-i${e}`)}
          {entry.children.length > 0 && blocks(entry.children, `${k}-i${e}c`)}
        </li>
      ))
      out.push(ordered ? <ol key={k}>{rendered}</ol> : <ul key={k}>{rendered}</ul>)
      continue
    }

    const paragraph: string[] = []
    while (
      i < source.length &&
      source[i].trim() &&
      !FENCE.test(source[i]) &&
      !HEADING.test(source[i]) &&
      !RULE.test(source[i]) &&
      !ITEM.test(source[i]) &&
      !QUOTE.test(source[i]) &&
      !(source[i].includes('|') && i + 1 < source.length && TABLE_RULE.test(source[i + 1]))
    ) {
      paragraph.push(source[i++].trim())
    }
    if (!paragraph.length) paragraph.push(source[i++].trim())
    const k = key()
    out.push(<p key={k}>{lines(paragraph.join('\n'), k)}</p>)
  }
  return out
}

export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{blocks(text.replace(/\r\n?/g, '\n').split('\n'), 'm')}</div>
}
