import test from 'node:test';
import assert from 'node:assert/strict';
import { LEDGER_CAPACITY, TokenLedger } from '../src/token-ledger.js';

test('saved tokens are input minus output and never negative', () => {
  const ledger = new TokenLedger();
  assert.equal(ledger.record('squeze_context', { inputTokens: 1000, outputTokens: 250 }, 1).savedTokens, 750);
  assert.equal(ledger.record('squeze_context', { inputTokens: 100, outputTokens: 400 }, 2).savedTokens, 0);
  assert.deepEqual(ledger.totals(), { calls: 2, inputTokens: 1100, outputTokens: 650, savedTokens: 750 });
});

test('non-finite and negative samples count as zero', () => {
  const ledger = new TokenLedger();
  const entry = ledger.record('squeze.pack', { inputTokens: Number.NaN, outputTokens: -5 }, 1);
  assert.deepEqual([entry.inputTokens, entry.outputTokens, entry.savedTokens], [0, 0, 0]);
});

test('lifetime totals keep counting after old entries are evicted', () => {
  const ledger = new TokenLedger();
  for (let i = 0; i < LEDGER_CAPACITY + 3; i++) ledger.record('squeze_context', { inputTokens: 10, outputTokens: 4 }, i);
  assert.equal(ledger.totals().calls, LEDGER_CAPACITY + 3);
  assert.equal(ledger.totals().savedTokens, 6 * (LEDGER_CAPACITY + 3));
  assert.equal(ledger.toJSON().entries.length, LEDGER_CAPACITY);
});

test('recent returns newest first and treats a zero limit as empty', () => {
  const ledger = new TokenLedger();
  ledger.record('a', { inputTokens: 1, outputTokens: 0 }, 1);
  ledger.record('b', { inputTokens: 1, outputTokens: 0 }, 2);
  assert.deepEqual(ledger.recent(1).map(entry => entry.tool), ['b']);
  assert.deepEqual(ledger.recent(10).map(entry => entry.tool), ['b', 'a']);
  assert.deepEqual(ledger.recent(0), []);
});

test('round-trips through JSON storage', () => {
  const ledger = new TokenLedger();
  ledger.record('squeze_context', { inputTokens: 900, outputTokens: 300 }, 42);
  const restored = TokenLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  assert.deepEqual(restored.totals(), ledger.totals());
  assert.deepEqual(restored.recent(10), ledger.recent(10));
});

test('fromJSON ignores malformed storage instead of throwing', () => {
  for (const value of [null, 'x', [], { version: 2, entries: [] }, { version: 1, entries: 'nope', lifetime: 5 }]) {
    const ledger = TokenLedger.fromJSON(value);
    assert.deepEqual(ledger.totals(), { calls: 0, inputTokens: 0, outputTokens: 0, savedTokens: 0 });
    assert.deepEqual(ledger.recent(10), []);
  }
});

test('fromJSON drops bad entries and recomputes savings from the token counts', () => {
  const restored = TokenLedger.fromJSON({
    version: 1,
    lifetime: { calls: 2, inputTokens: 1000, outputTokens: 100, savedTokens: 900 },
    entries: [
      { at: 5, tool: 'squeze_context', inputTokens: 1000, outputTokens: 100, savedTokens: 999999 },
      { at: 6, inputTokens: 1, outputTokens: 1 },
      'junk',
    ],
  });
  const recent = restored.recent(10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].savedTokens, 900);
  assert.equal(restored.totals().calls, 2);
  assert.equal(restored.totals().savedTokens, 900);
});
