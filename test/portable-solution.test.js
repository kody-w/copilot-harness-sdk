import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/portable-solution.mjs', import.meta.url));
const py = `
import sys, zipfile
mode = sys.argv[1]
if mode == "create":
    _, _, src, out = sys.argv
    import os
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(src):
            for name in files:
                path = os.path.join(root, name)
                z.write(path, os.path.relpath(path, src).replace(os.sep, "/"))
elif mode == "read":
    _, _, zip_path, member = sys.argv
    sys.stdout.buffer.write(zipfile.ZipFile(zip_path).read(member))
`;
function zipCreate(src, out) {
  runPythonZip(['create', src, out]);
}
function zipRead(zip, member, encoding) {
  const bytes = runPythonZip(['read', zip, member]);
  return encoding ? bytes.toString(encoding) : bytes;
}
function runPythonZip(args) {
  for (const candidate of ['python', 'python3']) {
    try {
      return execFileSync(candidate, ['-c', py, ...args]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('python is required to create the zip fixture');
}

test('portable-solution strips the org URL and connector id to tokens and localize restores them byte for byte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portable-'));
  const src = join(dir, 'src'); mkdirSync(join(src, 'bots', 'x'), { recursive: true });
  const xml = '<bot><instructions>the organization is exactly `https://org123.crm.dynamics.com/`</instructions><api>shared_new-5frapp-20hacker-20news-5fabc</api><host>https://org123.crm.dynamics.com</host></bot>';
  writeFileSync(join(src, 'bots', 'x', 'bot.xml'), xml);
  writeFileSync(join(src, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  zipCreate(src, join(dir, 'in.zip'));
  const args = ['--org-url', 'https://org123.crm.dynamics.com/', '--hn-connector', 'shared_new-5frapp-20hacker-20news-5fabc'];
  const out = execFileSync('node', [script, 'strip', join(dir, 'in.zip'), join(dir, 'portable.zip'), ...args], { encoding: 'utf8' });
  assert.match(out, /strip: 1 file\(s\) rewritten/);
  const portable = zipRead(join(dir, 'portable.zip'), 'bots/x/bot.xml', 'utf8');
  assert.doesNotMatch(portable, /org123/);
  assert.match(portable, /\{\{ORG_URL\}\}/); assert.match(portable, /\{\{HN_CONNECTOR\}\}/); assert.match(portable, /\{\{ORG_URL_NO_SLASH\}\}/);
  execFileSync('node', [script, 'localize', join(dir, 'portable.zip'), join(dir, 'back.zip'), ...args]);
  assert.equal(zipRead(join(dir, 'back.zip'), 'bots/x/bot.xml', 'utf8'), xml);
  assert.deepEqual([...zipRead(join(dir, 'back.zip'), 'binary.bin')], [0, 1, 2, 3]);
});
