import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { ClaudeSession } from '../src/session';

// A stand-in for the Claude CLI in streaming mode. It answers each request line
// with "<pid>:<n>:<prompt>", so tests can see which process served a request and
// in what order. Special prompts: "slow" never answers, "fail" reports an error.
const FAKE = `
let buffer = '';
let served = 0;
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const prompt = JSON.parse(line).message.content;
    if (prompt === 'slow') continue;
    served++;
    console.log(JSON.stringify({ type: 'assistant' }));
    console.log(JSON.stringify(prompt === 'fail'
      ? { type: 'result', is_error: true, result: 'Not signed in' }
      : { type: 'result', is_error: false, result: process.pid + ':' + served + ':' + prompt }));
  }
});
process.stdin.on('end', () => process.exit(0));
`;

let dir: string;
let bin: string;
const sessions: ClaudeSession[] = [];

function session(overrides: { bin?: string; timeoutMs?: number; maxRequests?: number } = {}): ClaudeSession {
  const created = new ClaudeSession(
    () => ({ bin: overrides.bin ?? bin, model: 'sonnet', timeoutMs: overrides.timeoutMs ?? 20000, cwd: os.tmpdir() }),
    overrides.maxRequests ?? 20,
  );
  sessions.push(created);
  return created;
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-session-'));
  fs.writeFileSync(path.join(dir, 'fake.js'), FAKE);
  if (process.platform === 'win32') {
    bin = path.join(dir, 'fake.cmd');
    fs.writeFileSync(bin, '@echo off\r\nnode "%~dp0fake.js" %*\r\n');
  } else {
    bin = path.join(dir, 'fake');
    fs.writeFileSync(bin, '#!/bin/sh\nexec node "$(dirname "$0")/fake.js" "$@"\n', { mode: 0o755 });
  }
});

after(async () => {
  sessions.forEach((s) => s.dispose());
  // Give killed processes a moment to let go of the folder.
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('requests are answered in order by one process', async () => {
  const s = session();
  const replies = await Promise.all([s.ask('a'), s.ask('b'), s.ask('c')]);
  const [pids, counts, prompts] = [0, 1, 2].map((i) => replies.map((r) => r.split(':')[i]));
  assert.deepEqual(prompts, ['a', 'b', 'c']);
  assert.deepEqual(counts, ['1', '2', '3']);
  assert.equal(new Set(pids).size, 1);
});

test('the process is replaced after maxRequests', async () => {
  const s = session({ maxRequests: 2 });
  const pids = [];
  for (const prompt of ['a', 'b', 'c']) {
    pids.push((await s.ask(prompt)).split(':')[0]);
  }
  assert.equal(pids[0], pids[1]);
  assert.notEqual(pids[1], pids[2]);
});

test('an error reported by the CLI rejects that request only', async () => {
  const s = session();
  await assert.rejects(s.ask('fail'), /Not signed in/);
  assert.match(await s.ask('still works'), /still works$/);
});

test('cancelling a request in flight lets the next one through on a new process', async () => {
  const s = session();
  const first = (await s.ask('warm')).split(':')[0];
  const abort = new AbortController();
  const slow = s.ask('slow', abort.signal);
  const queued = s.ask('after');
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(slow, /cancelled/);
  const reply = await queued;
  assert.match(reply, /:1:after$/);
  assert.notEqual(reply.split(':')[0], first);
});

test('cancelling a queued request leaves the others alone', async () => {
  const s = session();
  const abort = new AbortController();
  const a = s.ask('a');
  const b = s.ask('b', abort.signal);
  const c = s.ask('c');
  abort.abort();
  await assert.rejects(b, /cancelled/);
  assert.match(await a, /:a$/);
  assert.match(await c, /:2:c$/);
});

test('a request that takes too long is stopped with a clear message', async () => {
  const s = session({ timeoutMs: 300 });
  await assert.rejects(s.ask('slow'), /took longer than 0 seconds/);
  assert.match(await session().ask('ok'), /:ok$/);
});

test('a missing CLI is reported as such', async () => {
  const s = session({ bin: path.join(dir, 'no-such-cli') });
  await assert.rejects(s.ask('a'), /CLI was not found/);
});

test('a disposed session refuses work', async () => {
  const s = session();
  const pending = s.ask('slow');
  s.dispose();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(s.ask('a'), /cancelled/);
});
