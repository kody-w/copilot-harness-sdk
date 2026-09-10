#!/usr/bin/env python3
"""Render docs/ghcp-harness-copilot-sdk-reference.md into a self-contained HTML page.

Canonical content lives in the Markdown file; this script only wraps it in the
designed shell (tokens, type, TOC rail, pinout strip). Re-run after editing the .md.
"""
import html
import re
import sys
from pathlib import Path

import markdown
from markdown.extensions.toc import TocExtension

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "docs" / "ghcp-harness-copilot-sdk-reference.md"
OUT = REPO / "docs" / "ghcp-harness-copilot-sdk-reference.html"

md_text = SRC.read_text(encoding="utf-8")

# Strip the H1 and the intro bullet list up to the first --- ; the shell renders those itself.
lines = md_text.split("\n")
if not lines[0].startswith("# "):
    sys.exit("unexpected header shape: no H1")
title = lines[0][2:].strip()
# lede = first non-empty paragraph after the H1; intro = the bullet list that follows; body = after first ---
i = 1
while lines[i].strip() == "":
    i += 1
lede_lines = []
while lines[i].strip() != "":
    lede_lines.append(lines[i]); i += 1
lede = " ".join(lede_lines).strip()
while lines[i].strip() == "":
    i += 1
intro_items = []
while lines[i].startswith("- "):
    intro_items.append(lines[i][2:].strip()); i += 1
while lines[i].strip() != "---":
    i += 1
body_md = "\n".join(lines[i + 1:])

mdx = markdown.Markdown(
    extensions=["tables", "fenced_code", "sane_lists", TocExtension(toc_depth="2-3", anchorlink=False)],
    output_format="html5",
)
body_html = mdx.convert(body_md)
toc_html = mdx.toc

# Wrap tables so they scroll in their own container.
body_html = body_html.replace("<table>", '<div class="tbl"><table>').replace("</table>", "</table></div>")

# Status chips in table cells (exact-cell matches only).
def chip(cls, text):
    return f'<span class="chip chip-{cls}">{text}</span>'

body_html = re.sub(r"<td>Yes</td>", "<td>" + chip("ok", "Yes") + "</td>", body_html)
body_html = re.sub(r"<td>No</td>", "<td>" + chip("no", "No") + "</td>", body_html)
body_html = re.sub(r"<td><strong>No</strong></td>", "<td>" + chip("no", "No") + "</td>", body_html)

# Letter badges in the first column of the §1 table.
body_html = re.sub(r"<td><strong>([A-E])</strong></td>", r'<td><span class="letter">\1</span></td>', body_html)

# Section numbers: h2 text like "1. The five things..." -> eyebrow number + title.
def h2_fix(mo):
    attrs, text = mo.group(1), mo.group(2)
    n = re.match(r"(\d+)\.\s+(.*)", text)
    if n:
        return f'<h2{attrs}><span class="num">{n.group(1)}</span>{n.group(2)}</h2>'
    return mo.group(0)

body_html = re.sub(r"<h2([^>]*)>(.*?)</h2>", h2_fix, body_html)

intro_html = "".join(f"<li>{markdown.markdown(item)[3:-4]}</li>" for item in intro_items)
lede_html = markdown.markdown(lede)

page = f"""<title>{html.escape(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@500;600;700&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root {{
  --ground: #f4f6f8;
  --surface: #ffffff;
  --surface-2: #eaeef3;
  --ink: #16202b;
  --muted: #5c6b7a;
  --line: #d5dce4;
  --line-strong: #b9c3cf;
  --accent: #b5622e;
  --accent-ink: #8e4a1f;
  --accent-soft: #f5e6da;
  --code-bg: #eef2f6;
  --code-ink: #24303c;
  --ok: #2e7d5b;
  --ok-soft: #dff1e8;
  --no: #b3413a;
  --no-soft: #f7e1df;
  --warn: #9a6b00;
  --warn-soft: #f6ecce;
  --shadow: 0 1px 2px rgba(22,32,43,.06), 0 8px 24px -12px rgba(22,32,43,.18);
  --display: "Barlow Semi Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif;
  --body: "Source Sans 3", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  color-scheme: light dark;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --ground: #0f151c;
    --surface: #171f29;
    --surface-2: #1f2934;
    --ink: #e4e9ee;
    --muted: #97a5b3;
    --line: #2a3542;
    --line-strong: #3a4756;
    --accent: #e39a63;
    --accent-ink: #f0b47f;
    --accent-soft: #3a2a1f;
    --code-bg: #0b1117;
    --code-ink: #d7dee6;
    --ok: #5fbf95;
    --ok-soft: #173327;
    --no: #e07a73;
    --no-soft: #3b1e1c;
    --warn: #e0b34a;
    --warn-soft: #3a2f12;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.6);
  }}
}}
:root[data-theme="dark"] {{
  --ground: #0f151c;
  --surface: #171f29;
  --surface-2: #1f2934;
  --ink: #e4e9ee;
  --muted: #97a5b3;
  --line: #2a3542;
  --line-strong: #3a4756;
  --accent: #e39a63;
  --accent-ink: #f0b47f;
  --accent-soft: #3a2a1f;
  --code-bg: #0b1117;
  --code-ink: #d7dee6;
  --ok: #5fbf95;
  --ok-soft: #173327;
  --no: #e07a73;
  --no-soft: #3b1e1c;
  --warn: #e0b34a;
  --warn-soft: #3a2f12;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 24px -12px rgba(0,0,0,.6);
}}
* {{ box-sizing: border-box; }}
html {{ scroll-behavior: smooth; }}
@media (prefers-reduced-motion: reduce) {{ html {{ scroll-behavior: auto; }} }}
body {{
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--body);
  font-size: 16.5px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}}
a {{ color: var(--accent-ink); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 45%, transparent); text-underline-offset: 2px; }}
a:hover {{ text-decoration-color: var(--accent); }}
a:focus-visible, button:focus-visible, summary:focus-visible {{ outline: 2px solid var(--accent); outline-offset: 2px; }}
code, pre, kbd {{ font-family: var(--mono); }}
code {{ font-size: .86em; background: var(--code-bg); color: var(--code-ink); padding: .08em .35em; border-radius: 3px; }}
pre {{ background: var(--code-bg); color: var(--code-ink); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; overflow-x: auto; font-size: .84rem; line-height: 1.5; }}
pre code {{ background: none; padding: 0; font-size: inherit; }}

/* Masthead */
.mast {{
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}}
.mast-inner {{
  max-width: 1240px; margin: 0 auto; padding: 36px 28px 26px;
  display: grid; gap: 22px;
}}
.eyebrow {{
  font-family: var(--display); font-weight: 600; font-size: .78rem; letter-spacing: .12em; text-transform: uppercase; color: var(--accent-ink);
  display: flex; gap: 14px; flex-wrap: wrap; align-items: center;
}}
.eyebrow .sep {{ color: var(--line-strong); }}
h1 {{
  font-family: var(--display); font-weight: 700; font-size: clamp(2.1rem, 4.2vw, 3.3rem); line-height: 1.02; letter-spacing: -.01em; margin: 6px 0 0;
  text-wrap: balance;
}}
.lede {{ max-width: 68ch; font-size: 1.12rem; color: var(--muted); margin: 0; }}
.lede p {{ margin: 0; }}
.legend {{
  display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px 22px;
  margin: 0; padding: 0; list-style: none; font-size: .95rem; color: var(--muted);
}}
.legend li {{ padding-left: 14px; position: relative; }}
.legend li::before {{ content: ""; position: absolute; left: 0; top: .62em; width: 6px; height: 6px; background: var(--accent); border-radius: 1px; }}
.legend code {{ font-size: .8em; }}

/* Pinout strip */
.pinout {{
  display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0; align-items: stretch;
  border: 1px solid var(--line); border-radius: 8px; background: var(--ground); overflow: hidden;
}}
.pin {{
  padding: 14px 14px 12px; border-right: 1px solid var(--line); display: grid; grid-template-rows: auto auto 1fr auto; gap: 4px; min-height: 100%;
  position: relative;
}}
.pin:last-child {{ border-right: 0; }}
.pin + .pin {{ padding-left: 34px; }}
.pin .letter {{ margin-bottom: 2px; }}
.pin .name {{ font-family: var(--display); font-weight: 600; font-size: 1.02rem; line-height: 1.15; }}
.pin .what {{ font-size: .86rem; color: var(--muted); line-height: 1.35; }}
.pin .pkg {{ font-family: var(--mono); font-size: .72rem; color: var(--ink); margin-top: 6px; overflow-wrap: anywhere; }}
.pin.hosted {{ background: var(--accent-soft); }}
.pin[data-link]::after {{
  content: attr(data-link); position: absolute; right: -1px; top: 50%; transform: translate(50%, -50%);
  background: var(--surface); border: 1px solid var(--line-strong); color: var(--muted);
  font-family: var(--mono); font-size: .66rem; padding: 1px 6px; border-radius: 10px; z-index: 1; white-space: nowrap;
}}
.pinout-note {{ font-size: .92rem; color: var(--muted); margin: -8px 0 0; }}
.letter {{
  display: inline-grid; place-items: center; width: 1.55em; height: 1.55em; border-radius: 4px;
  background: var(--accent); color: #fff; font-family: var(--display); font-weight: 700; font-size: .9em; line-height: 1;
}}
@media (max-width: 900px) {{
  .pinout {{ grid-template-columns: 1fr 1fr; }}
  .pin {{ border-bottom: 1px solid var(--line); }}
  .pin[data-link]::after {{ display: none; }}
}}
@media (max-width: 560px) {{ .pinout {{ grid-template-columns: 1fr; }} }}

/* Two-column body */
.wrap {{ max-width: 1240px; margin: 0 auto; padding: 28px 28px 80px; display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 40px; }}
.rail {{ position: sticky; top: 18px; align-self: start; max-height: calc(100vh - 36px); overflow: auto; font-size: .9rem; }}
.rail .rail-title {{ font-family: var(--display); font-weight: 600; letter-spacing: .1em; text-transform: uppercase; font-size: .72rem; color: var(--muted); margin: 0 0 8px; }}
.rail ul {{ list-style: none; margin: 0; padding: 0; }}
.rail > ul > li {{ margin: 0 0 4px; }}
.rail a {{ display: block; padding: 3px 0 3px 10px; border-left: 2px solid var(--line); color: var(--ink); text-decoration: none; line-height: 1.3; }}
.rail a:hover {{ border-left-color: var(--accent); color: var(--accent-ink); }}
.rail ul ul a {{ padding-left: 18px; color: var(--muted); font-size: .85rem; }}
.rail details {{ display: none; }}
article {{ min-width: 0; max-width: 900px; }}
article > p, article > ul, article > ol {{ max-width: 72ch; }}
article h2 {{
  font-family: var(--display); font-weight: 700; font-size: 1.85rem; line-height: 1.1; margin: 56px 0 14px; letter-spacing: -.005em; text-wrap: balance;
  display: flex; align-items: baseline; gap: 12px; scroll-margin-top: 20px;
}}
article h2:first-of-type {{ margin-top: 8px; }}
article h2 .num {{ font-family: var(--mono); font-weight: 500; font-size: .95rem; color: var(--accent-ink); }}
article h3 {{ font-family: var(--display); font-weight: 600; font-size: 1.22rem; margin: 30px 0 8px; scroll-margin-top: 20px; }}
article p {{ margin: 0 0 12px; }}
article ul, article ol {{ padding-left: 1.25em; margin: 0 0 14px; }}
article li {{ margin: 0 0 5px; }}
article li > p {{ margin: 0; }}
article strong {{ font-weight: 600; }}
article hr {{ border: 0; border-top: 1px solid var(--line); margin: 40px 0 0; }}
blockquote {{ margin: 0 0 14px; padding: 8px 16px; border-left: 3px solid var(--accent); background: var(--surface); color: var(--ink); }}

/* Tables */
.tbl {{ overflow-x: auto; margin: 6px 0 20px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: var(--shadow); }}
table {{ border-collapse: collapse; width: 100%; font-size: .92rem; font-variant-numeric: tabular-nums; }}
th, td {{ text-align: left; vertical-align: top; padding: 9px 12px; border-bottom: 1px solid var(--line); }}
th {{ font-family: var(--display); font-weight: 600; font-size: .8rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); background: var(--surface-2); position: sticky; top: 0; }}
tr:last-child td {{ border-bottom: 0; }}
td code {{ white-space: nowrap; }}
td code:has(+ code), td code + code {{ white-space: normal; }}
.tbl table td:first-child {{ font-weight: 600; }}
.chip {{ display: inline-block; font-family: var(--display); font-weight: 600; font-size: .74rem; letter-spacing: .06em; text-transform: uppercase; padding: 1px 8px; border-radius: 999px; line-height: 1.5; }}
.chip-ok {{ background: var(--ok-soft); color: var(--ok); }}
.chip-no {{ background: var(--no-soft); color: var(--no); }}
.chip-warn {{ background: var(--warn-soft); color: var(--warn); }}

@media (max-width: 960px) {{
  .wrap {{ grid-template-columns: 1fr; gap: 20px; padding: 20px 18px 60px; }}
  .rail {{ position: static; max-height: none; }}
  .rail > .rail-title, .rail > ul {{ display: none; }}
  .rail details {{ display: block; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); padding: 8px 12px; }}
  .rail summary {{ cursor: pointer; font-family: var(--display); font-weight: 600; letter-spacing: .08em; text-transform: uppercase; font-size: .74rem; color: var(--muted); }}
  .rail details ul {{ margin-top: 8px; }}
  .mast-inner {{ padding: 26px 18px 20px; }}
}}
@media print {{
  .rail {{ display: none; }}
  .wrap {{ grid-template-columns: 1fr; }}
  .tbl {{ box-shadow: none; }}
  a {{ color: inherit; }}
}}
</style>

<header class="mast">
  <div class="mast-inner">
    <div class="eyebrow"><span>Reference</span><span class="sep">/</span><span>Verified 6 September 2026</span><span class="sep">/</span><span>Copilot Studio · GitHub Copilot SDK · Agent Framework</span></div>
    <h1>{html.escape(title)}</h1>
    <div class="lede">{lede_html}</div>
    <div class="pinout" aria-label="How the five pieces connect">
      <div class="pin" data-link="drives">
        <span class="letter">A</span>
        <div class="name">GitHub Copilot CLI harness</div>
        <div class="what">The agent loop: model calls, tools, permissions, MCP, skills, sub-agents, sessions.</div>
        <div class="pkg">copilot --headless · v1.0.83</div>
      </div>
      <div class="pin" data-link="wraps">
        <span class="letter">B</span>
        <div class="name">GitHub Copilot SDK</div>
        <div class="what">JSON-RPC client for A in six languages. GA 2 Jun 2026.</div>
        <div class="pkg">@github/copilot-sdk 1.0.13</div>
      </div>
      <div class="pin">
        <span class="letter">C</span>
        <div class="name">Agent Framework provider</div>
        <div class="what">B as an <code>AIAgent</code>: instructions, tools, middleware, OTel, approval.</div>
        <div class="pkg">Microsoft.Agents.AI.GitHub.Copilot 1.20.0</div>
      </div>
      <div class="pin" data-link="calls">
        <span class="letter">E</span>
        <div class="name">Copilot Studio client library</div>
        <div class="what">Direct-to-Engine client for a published Studio agent. Standard harness only, officially.</div>
        <div class="pkg">Microsoft.Agents.AI.CopilotStudio 1.20.0-preview</div>
      </div>
      <div class="pin hosted">
        <span class="letter">D</span>
        <div class="name">Copilot Studio GitHub Copilot harness</div>
        <div class="what">The same lineage as A, hosted by Microsoft with connectors, skills, memory, Office files, Copilot Credits. GA 3 Aug 2026.</div>
        <div class="pkg">agenticruntime /3p · Teams · M365 Copilot · iframe</div>
      </div>
    </div>
    <p class="pinout-note">A, B and C run the loop inside your process under GitHub identity. D runs it as a Microsoft-managed agent under Entra identity. E is how code reaches D, and today that is supported only for the standard harness.</p>
    <ul class="legend">{intro_html}</ul>
  </div>
</header>

<div class="wrap">
  <nav class="rail" aria-label="Contents">
    <p class="rail-title">Contents</p>
    {toc_html.replace('<div class="toc">', '').replace('</div>', '')}
    <details><summary>Contents</summary>{toc_html.replace('<div class="toc">', '').replace('</div>', '')}</details>
  </nav>
  <article>
{body_html}
  </article>
</div>
"""

OUT.write_text(page, encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes)")
