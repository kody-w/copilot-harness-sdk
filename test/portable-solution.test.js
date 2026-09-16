import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../scripts/portable-solution.mjs', import.meta.url).pathname;

test('portable-solution strips the org URL and connector id to tokens and localize restores them byte for byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portable-'));
  const src = join(dir, 'src'); mkdirSync(join(src, 'bots', 'x'), { recursive: true });
  const xml = '<bot><instructions>the organization is exactly `https://org123.crm.dynamics.com/`</instructions><api>shared_new-5frapp-20hacker-20news-5fabc</api><host>https://org123.crm.dynamics.com</host></bot>';
  writeFileSync(join(src, 'bots', 'x', 'bot.xml'), xml);
  writeFileSync(join(src, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  execFileSync('zip', ['-q', '-r', join(dir, 'in.zip'), '.'], { cwd: src });
  const args = ['--org-url', 'https://org123.crm.dynamics.com/', '--hn-connector', 'shared_new-5frapp-20hacker-20news-5fabc'];
  const out = execFileSync('node', [script, 'strip', join(dir, 'in.zip'), join(dir, 'portable.zip'), ...args], { encoding: 'utf8' });
  assert.match(out, /strip: 1 file\(s\) rewritten/);
  const portable = execFileSync('unzip', ['-p', join(dir, 'portable.zip'), 'bots/x/bot.xml'], { encoding: 'utf8' });
  assert.doesNotMatch(portable, /org123/);
  assert.match(portable, /\{\{ORG_URL\}\}/); assert.match(portable, /\{\{HN_CONNECTOR\}\}/); assert.match(portable, /\{\{ORG_URL_NO_SLASH\}\}/);
  execFileSync('node', [script, 'localize', join(dir, 'portable.zip'), join(dir, 'back.zip'), ...args]);
  assert.equal(execFileSync('unzip', ['-p', join(dir, 'back.zip'), 'bots/x/bot.xml'], { encoding: 'utf8' }), xml);
  assert.deepEqual([...execFileSync('unzip', ['-p', join(dir, 'back.zip'), 'binary.bin'])], [0, 1, 2, 3]);
});
