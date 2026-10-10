import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CopilotBackend, describeCopilotError, LmApi, LmModel } from '../src/copilot';

interface Sent {
  model: string;
  message: string;
  justification?: string;
}

/** A stand-in for VS Code's language model API with scriptable models. */
function fakeLm(models: Partial<Record<string, (prompt: string, cancelled: () => boolean) => AsyncIterable<string>>>) {
  const sent: Sent[] = [];
  const selectors: { vendor: string; family?: string }[] = [];
  const lm: LmApi = {
    selectChatModels: async (selector) => {
      selectors.push(selector);
      return Object.keys(models)
        .filter((family) => !selector.family || selector.family === family)
        .map(
          (family): LmModel => ({
            id: family,
            name: family,
            family,
            sendRequest: async (messages, options, token) => {
              sent.push({ model: family, message: messages[0] as string, justification: options.justification });
              return { text: models[family]!(messages[0] as string, () => (token as { cancelled: boolean }).cancelled) };
            },
          }),
        );
    },
    userMessage: (content) => content,
    createCancellation: () => {
      const token = { cancelled: false };
      return { token, cancel: () => (token.cancelled = true), dispose: () => undefined };
    },
  };
  return { lm, sent, selectors };
}

async function* chunks(...parts: string[]): AsyncIterable<string> {
  for (const part of parts) {
    yield part;
  }
}

/** Streams forever until the request is cancelled, the way a slow model would. */
async function* slow(cancelled: () => boolean): AsyncIterable<string> {
  while (!cancelled()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    yield '.';
  }
}

const options = (family = '', timeoutMs = 5000) => () => ({ family, timeoutMs });

test('a reply is assembled from the streamed chunks', async () => {
  const { lm, sent, selectors } = fakeLm({ 'gpt-4o': () => chunks('{"summary":', ' "ok"}') });
  const backend = new CopilotBackend(lm, options());
  assert.equal(await backend.ask('THE PROMPT'), '{"summary": "ok"}');
  assert.deepEqual(selectors, [{ vendor: 'copilot' }]);
  assert.match(sent[0].message, /Reply with one JSON object only\.\n\nTHE PROMPT$/);
  assert.ok(sent[0].justification);
});

test('a chosen model family is requested, and reported when missing', async () => {
  const { lm, sent, selectors } = fakeLm({ 'gpt-4o': () => chunks('a'), 'claude-sonnet': () => chunks('b') });
  assert.equal(await new CopilotBackend(lm, options('claude-sonnet')).ask('p'), 'b');
  assert.deepEqual(selectors[0], { vendor: 'copilot', family: 'claude-sonnet' });
  assert.equal(sent[0].model, 'claude-sonnet');
  await assert.rejects(new CopilotBackend(lm, options('no-such-model')).ask('p'), /no model called "no-such-model"/);
});

test('no Copilot at all is explained', async () => {
  await assert.rejects(new CopilotBackend(fakeLm({}).lm, options()).ask('p'), /GitHub Copilot is not available/);
});

test('requests run one at a time, in order, and a failure does not block the next', async () => {
  let active = 0;
  let maxActive = 0;
  const { lm } = fakeLm({
    m: async function* (prompt) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      if (prompt.endsWith('bad')) {
        throw Object.assign(new Error('quota'), { code: 'Blocked' });
      }
      yield prompt.slice(-1);
    },
  });
  const backend = new CopilotBackend(lm, options());
  const results = await Promise.allSettled([backend.ask('a'), backend.ask('bad'), backend.ask('c')]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.match((results[1] as PromiseRejectedResult).reason.message, /usage limit/);
  assert.equal((results[2] as PromiseFulfilledResult<string>).value, 'c');
  assert.equal(maxActive, 1);
});

test('cancelling stops the request', async () => {
  const { lm } = fakeLm({ m: (_prompt, cancelled) => slow(cancelled) });
  const backend = new CopilotBackend(lm, options());
  const abort = new AbortController();
  const pending = backend.ask('p', abort.signal);
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(pending, /cancelled/);

  abort.abort();
  await assert.rejects(backend.ask('p', abort.signal), /cancelled/);
});

test('a request that takes too long is stopped with a clear message', async () => {
  const { lm } = fakeLm({ m: (_prompt, cancelled) => slow(cancelled) });
  await assert.rejects(new CopilotBackend(lm, options('', 100)).ask('p'), /took longer than 0 seconds/);
});

test('describeCopilotError tells the user what to do for each failure', () => {
  const error = (code: string) => describeCopilotError(Object.assign(new Error('raw'), { code })).message;
  assert.match(error('NoPermissions'), /choose Allow/);
  assert.match(error('Blocked'), /usage limit/);
  assert.match(error('NotFound'), /no longer available/);
  assert.match(describeCopilotError(new Error('network down')).message, /could not write the review: network down/);
});

test('a disposed backend refuses work', async () => {
  const backend = new CopilotBackend(fakeLm({ m: () => chunks('x') }).lm, options());
  backend.dispose();
  await assert.rejects(backend.ask('p'), /cancelled/);
});
