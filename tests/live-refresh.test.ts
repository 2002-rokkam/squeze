import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshScheduler, isWatchedPath } from '../src/live-refresh.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('a burst of triggers collapses into one run', async () => {
  let runs = 0;
  const scheduler = createRefreshScheduler(async () => { runs += 1; }, { delayMs: 30 });
  for (let i = 0; i < 10; i++) {
    scheduler.trigger();
    await sleep(3);
  }
  await sleep(120);
  assert.equal(runs, 1);
  scheduler.dispose();
});

test('triggers during a run schedule exactly one follow-up run', async () => {
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scheduler = createRefreshScheduler(async () => {
    runs += 1;
    if (runs === 1) await gate;
  }, { delayMs: 5 });
  scheduler.trigger();
  await sleep(30);
  scheduler.trigger();
  scheduler.trigger();
  scheduler.trigger();
  await sleep(30);
  assert.equal(runs, 1);
  release();
  await sleep(80);
  assert.equal(runs, 2);
  scheduler.dispose();
});

test('dispose cancels a pending run', async () => {
  let runs = 0;
  const scheduler = createRefreshScheduler(async () => { runs += 1; }, { delayMs: 20 });
  scheduler.trigger();
  scheduler.dispose();
  scheduler.trigger();
  await sleep(60);
  assert.equal(runs, 0);
});

test('errors are reported and the scheduler keeps working', async () => {
  const errors: unknown[] = [];
  let runs = 0;
  const scheduler = createRefreshScheduler(async () => {
    runs += 1;
    if (runs === 1) throw new Error('boom');
  }, { delayMs: 5, onError: error => errors.push(error) });
  scheduler.trigger();
  await sleep(40);
  scheduler.trigger();
  await sleep(40);
  assert.equal(errors.length, 1);
  assert.equal(runs, 2);
  scheduler.dispose();
});

test('isWatchedPath skips git and node_modules at any depth and keeps ordinary source', () => {
  assert.equal(isWatchedPath('src/index.ts'), true);
  assert.equal(isWatchedPath('.github/workflows/ci.yml'), true);
  assert.equal(isWatchedPath('.git/index'), false);
  assert.equal(isWatchedPath('packages/a/node_modules/x/index.js'), false);
  assert.equal(isWatchedPath('src\\node_modules\\x.js'), false);
});
