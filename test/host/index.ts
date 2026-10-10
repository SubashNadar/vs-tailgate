// Runs inside a real VS Code window (see scripts/host-test.js). The workspace is a
// temporary repository with one edited file, one new file and one .env file.
// tailgate.claudePath points at a stand-in CLI that returns canned reviews, and
// live review is switched on.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TailgateApi } from '../../src/extension';

async function until<T>(what: string, read: () => T | undefined | false, timeoutMs = 30000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function scenario(log: (step: string) => void): Promise<void> {
  const repo = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const promptFile = process.env.TAILGATE_FAKE_PROMPT!;
  const prompts = () => (fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '');

  const extension = vscode.extensions.getExtension<TailgateApi>('tailgate-dev.tailgate');
  assert.ok(extension, 'extension is installed');
  assert.equal(extension.isActive, false, 'extension stays inactive until it is used');
  log('not activated at startup');

  await vscode.commands.executeCommand('tailgate.panel.focus');
  const api = await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['tailgate.review', 'tailgate.markReviewed', 'tailgate.refresh']) {
    assert.ok(commands.includes(id), `${id} is registered`);
  }
  log('activated by opening the panel; commands registered');

  await until('the changed files to be listed', () => api.getState().files.length === 3);
  assert.deepEqual(api.getState().files.map((f) => `${f.status} ${f.path}`).sort(), ['added .env', 'added notes.md', 'modified app.js']);
  log('changed files listed');

  const card = (file: string) => api.getState().cards?.[file];
  await until('each file to get its own live review', () => card('app.js')?.state === 'ready' && card('notes.md')?.state === 'ready');
  assert.equal(api.getState().live, true);
  assert.equal(card('app.js')!.review!.what, 'Card for app.js (first version).');
  assert.deepEqual(card('app.js')!.review!.risks.map((r) => [r.file, r.line]), [['app.js', 2]]);
  assert.ok(card('app.js')!.review!.question, 'the card carries a question');
  assert.equal(card('notes.md')!.review!.what, 'Card for notes.md (first version).');
  assert.equal(card('.env')!.state, 'skipped');
  assert.equal(api.getState().status, 'idle', 'live cards arrive without asking for a full review');
  log('live review: one card per file, .env skipped');

  const firstKey = card('app.js')!.key;
  fs.writeFileSync(path.join(repo, 'app.js'), 'function add(a, b) {\n  const total = a + b + 2;\n  return total;\n}\n');
  await until('the edited file to be reviewed again', () => card('app.js')?.state === 'ready' && card('app.js')!.key !== firstKey);
  assert.equal(card('app.js')!.review!.what, 'Card for app.js (second version).');
  assert.equal(card('notes.md')!.review!.what, 'Card for notes.md (first version).');
  const fileRequests = prompts().split('=====').filter((p) => p.includes('<file-diff>'));
  assert.equal(fileRequests.filter((p) => p.includes('diff --git a/notes.md')).length, 1, 'the untouched file is not reviewed twice');
  log('live review: an edited file gets a new card, untouched files keep theirs');

  const cardQuestion = `file:app.js:${card('app.js')!.key}`;
  await api.send({ type: 'answer', key: cardQuestion, text: 'it returns 3 now' });
  assert.deepEqual(api.getState().typed?.[cardQuestion], {
    state: 'ready',
    text: 'it returns 3 now',
    result: { verdict: 'correct', feedback: 'You have it.' },
  });
  await api.send({ type: 'answer', key: 'file:app.js:not-the-current-card', text: 'anything' });
  await api.send({ type: 'answer', key: 'file:notes.md:whatever', text: 'anything' });
  assert.deepEqual(Object.keys(api.getState().typed ?? {}), [cardQuestion], 'answers to questions that are not on screen are ignored');
  assert.match(prompts(), /<answer>\nit returns 3 now\n<\/answer>/);
  log("an answer typed in the user's own words is marked");

  await vscode.commands.executeCommand('tailgate.review');
  const state = await until('the full review', () => (['ready', 'error'].includes(api.getState().status) ? api.getState() : undefined));
  assert.equal(state.status, 'ready', state.error);
  assert.equal(state.review!.summary, 'Canned review from the stand-in CLI.');
  assert.equal(state.review!.questions.length, 1);
  assert.equal(state.excludedFiles, 1, 'the .env file is held back');
  assert.equal(card('app.js')!.state, 'ready', 'cards stay alongside the full review');
  log('full review written through the same process');

  const reviewQuestion = `all:${state.reviewTree}:0`;
  await api.send({ type: 'answer', key: reviewQuestion, text: 'no idea' });
  assert.equal(api.getState().typed?.[reviewQuestion]?.result?.verdict, 'incorrect');
  log('typed answers work on the full review too');

  assert.match(prompts(), /^\+ {2}const total = a \+ b \+ 2;$/m, 'the diff reaches the CLI');
  assert.doesNotMatch(prompts(), /not-a-real-secret/, 'secret file contents never reach the CLI');
  log('prompts contain the diff and no secret file contents');

  fs.writeFileSync(path.join(repo, 'later.txt'), 'written after the review\n');
  await until('the file watcher to notice a new file', () => api.getState().files.some((f) => f.path === 'later.txt'));
  assert.equal(api.getState().stale, true);
  await until('the new file to get a card', () => card('later.txt')?.state === 'ready');
  log('file watcher picked up a later change, flagged the full review as stale and reviewed the new file');

  await vscode.commands.executeCommand('tailgate.markReviewed');
  await until('the baseline to move', () => api.getState().status === 'idle' && api.getState().files.length === 1);
  assert.deepEqual(api.getState().files.map((f) => f.path), ['later.txt']);
  log('mark as reviewed keeps only the later change');

  await vscode.commands.executeCommand('tailgate.markReviewed');
  await until('everything to be reviewed', () => api.getState().files.length === 0);
  assert.deepEqual(Object.keys(api.getState().cards ?? {}), []);
  assert.deepEqual(Object.keys(api.getState().typed ?? {}), []);
  log('second mark as reviewed clears the list, the cards and the typed answers');

  // This profile has no Copilot, so switching to it must fail cleanly rather than hang or fall back to Claude.
  assert.equal(api.getState().provider, 'claude');
  const requestsBefore = prompts().split('=====').length;
  await api.send({ type: 'setProvider', provider: 'copilot' });
  await until('the provider to switch', () => api.getState().provider === 'copilot');
  fs.writeFileSync(path.join(repo, 'for-copilot.txt'), 'one more change\n');
  await until('the new file to be listed', () => api.getState().files.length === 1);
  await until('the live card to report the missing Copilot', () => card('for-copilot.txt')?.state === 'error');
  assert.match(card('for-copilot.txt')!.error!, /GitHub Copilot is not available/);
  await vscode.commands.executeCommand('tailgate.review');
  const failed = await until('the Copilot review to fail', () => (api.getState().status === 'error' ? api.getState() : undefined));
  assert.match(failed.error!, /GitHub Copilot is not available/);
  assert.equal(prompts().split('=====').length, requestsBefore, 'nothing is sent to the Claude CLI while Copilot is chosen');
  log('choosing Copilot without Copilot installed fails with a clear message and sends nothing to Claude');

  await api.send({ type: 'setProvider', provider: 'claude' });
  await until('the provider to switch back', () => api.getState().provider === 'claude');
  await vscode.commands.executeCommand('tailgate.review');
  await until('a Claude review after switching back', () => api.getState().status === 'ready');
  log('switching back to the Claude CLI works');
}

export async function run(): Promise<void> {
  const steps: string[] = [];
  const resultFile = process.env.TAILGATE_HOST_RESULT;
  let error: string | undefined;
  try {
    await scenario((step) => steps.push(step));
  } catch (err) {
    error = (err as Error).stack ?? String(err);
  }
  if (resultFile) {
    fs.writeFileSync(resultFile, JSON.stringify({ ok: !error, steps, error }, null, 2));
  }
  if (error) {
    throw new Error(error);
  }
}
