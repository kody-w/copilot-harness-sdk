import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/tutorial-rar.mjs', import.meta.url).pathname;
const AGENT = `from agents.basic_agent import BasicAgent
class HackerNewsAgent(BasicAgent):
    def __init__(self):
        self.name = "HackerNews"
        self.metadata = {"name": self.name, "description": "Fetches Hacker News.", "parameters": {"type": "object", "properties": {"count": {"type": "integer"}}}}
        super().__init__(self.name, self.metadata)
    def perform(self, count=10, **k):
        return "stories"
`;

test('tutorial --fetch-only takes local --agent-files (no registry) and matches them to profiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tut-'));
  const file = join(dir, 'hacker_news_agent.py');
  writeFileSync(file, AGENT);
  const r = spawnSync('node', [script, '--fetch-only', '--agent-files', file, '--work-dir', join(dir, 'work')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /hacker_news_agent\.py {2}local file ✓/);
  assert.doesNotMatch(r.stdout, /registry:/, 'local files only: the registry is never fetched');
  assert.match(r.stdout, /HackerNews → hackernews: custom connector/);
  assert.ok(existsSync(join(dir, 'work', 'agents', 'hacker_news_agent.py')));
  assert.equal(readFileSync(join(dir, 'work', 'agents', 'hacker_news_agent.py'), 'utf8'), AGENT);
  const missing = spawnSync('node', [script, '--fetch-only', '--agent-files', join(dir, 'nope.py'), '--work-dir', join(dir, 'w2')], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--agent-files: .*nope\.py does not exist/);
});
