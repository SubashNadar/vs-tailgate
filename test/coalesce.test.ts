import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coalesce } from '../src/coalesce';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a call made during a run waits for a run that started after it', async () => {
  let source = 'old';
  let seen = '';
  let runs = 0;
  const refresh = coalesce(async () => {
    runs++;
    const value = source;
    await tick();
    seen = value;
  });

  const first = refresh();
  // The world changes while the first run is already reading it.
  source = 'new';
  await refresh();

  assert.equal(seen, 'new');
  assert.equal(runs, 2);
  await first;
});

test('many overlapping calls cost one extra run, never parallel runs', async () => {
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  const refresh = coalesce(async () => {
    runs++;
    active++;
    maxActive = Math.max(maxActive, active);
    await tick();
    active--;
  });

  await Promise.all([refresh(), refresh(), refresh(), refresh()]);
  assert.equal(runs, 2);
  assert.equal(maxActive, 1);
});

test('a failed run rejects its callers and does not block later calls', async () => {
  let fail = true;
  const refresh = coalesce(async () => {
    if (fail) {
      throw new Error('boom');
    }
  });
  await assert.rejects(refresh(), /boom/);
  fail = false;
  await refresh();
});
