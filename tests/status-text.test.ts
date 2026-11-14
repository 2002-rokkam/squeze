import test from 'node:test';
import assert from 'node:assert/strict';
import { compactCount, indexedStatus, ledgerMarkdown } from '../src/status-text.js';
import { TokenLedger } from '../src/token-ledger.js';

test('compactCount: small values are exact, large values are abbreviated', () => {
  assert.equal(compactCount(0), '0');
  assert.equal(compactCount(950), '950');
  assert.equal(compactCount(1000), '1k');
  assert.equal(compactCount(1200), '1.2k');
  assert.equal(compactCount(9949), '9.9k');
  assert.equal(compactCount(12_000), '12k');
  assert.equal(compactCount(999_000), '999k');
  assert.equal(compactCount(1_000_000), '1M');
  assert.equal(compactCount(1_250_000), '1.3M');
});

test('compactCount: bad input becomes zero instead of NaN or a negative label', () => {
  assert.equal(compactCount(Number.NaN), '0');
  assert.equal(compactCount(Number.POSITIVE_INFINITY), '0');
  assert.equal(compactCount(-5), '0');
});

test('indexedStatus: names the file count and the estimated saving', () => {
  assert.equal(indexedStatus(1234, 56_000), '$(graph) Squeze · 1,234 files · ~56k saved');
  assert.equal(indexedStatus(0, 0), '$(graph) Squeze · 0 files · ~0 saved');
});

test('ledgerMarkdown: an empty ledger says so and reports zero reduction', () => {
  const text = ledgerMarkdown(new TokenLedger().totals(), []);
  assert.match(text, /^# Squeze token ledger/);
  assert.match(text, /not billing figures/);
  assert.match(text, /\| Pack calls \| 0 \|/);
  assert.match(text, /\| Reduction \| 0\.0% \|/);
  assert.match(text, /No pack calls recorded yet\./);
  assert.doesNotMatch(text, /Recent calls/);
});

test('ledgerMarkdown: totals, reduction and recent calls render with thousands separators', () => {
  const ledger = new TokenLedger();
  ledger.record('squeze.pack', { inputTokens: 10_000, outputTokens: 2_000 }, Date.UTC(2025, 0, 2, 3, 4, 5));
  ledger.record('squeze_context', { inputTokens: 4_000, outputTokens: 1_000 }, Date.UTC(2025, 0, 2, 3, 5, 6));
  const text = ledgerMarkdown(ledger.totals(), ledger.recent(10));
  assert.match(text, /\| Pack calls \| 2 \|/);
  assert.match(text, /\| Full repository \(est\. tokens\) \| 14,000 \|/);
  assert.match(text, /\| Returned \(tokens\) \| 3,000 \|/);
  assert.match(text, /\| Saved \(est\. tokens\) \| 11,000 \|/);
  assert.match(text, /\| Reduction \| 78\.6% \|/);
  assert.match(text, /\| 2025-01-02 03:05:06 \| squeze_context \| 1,000 \| 3,000 \|/);
  assert.match(text, /\| 2025-01-02 03:04:05 \| squeze\.pack \| 2,000 \| 8,000 \|/);
});

test('ledgerMarkdown: tool names cannot inject markdown and an unset time renders as a dash', () => {
  const text = ledgerMarkdown(
    { calls: 1, inputTokens: 100, outputTokens: 10, savedTokens: 90 },
    [{ at: 0, tool: 'evil | **x**\n# head', inputTokens: 100, outputTokens: 10, savedTokens: 90 }],
  );
  assert.match(text, /\| — \| evil\?{5}x\?{5}head \| 10 \| 90 \|/);
  assert.doesNotMatch(text, /\*\*x\*\*/);
  assert.doesNotMatch(text, /\n# head/);
});
