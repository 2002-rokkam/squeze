import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFollowUp, packOutcome, readUntilGold, sliceLines, withFollowUp } from '../bench/tokencost/accounting.js';
import { parsePackSource } from '../bench/tokencost/args.js';
import { parseCountOutput, rankFiles, type TermHits } from '../bench/tokencost/grep.js';
import { renderTokenCost } from '../bench/tokencost/render.js';
import { compare, summarize } from '../bench/tokencost/summary.js';
import { extractTerms } from '../bench/tokencost/terms.js';

const sizes: Record<string, number> = { 'a.py': 100, 'b.py': 200, 'c.py': 300, 'big.bin': -1 };
const fileTokens = (path: string) => (sizes[path] === undefined || sizes[path] < 0 ? null : sizes[path]);

test('readUntilGold sums listing and file tokens up to and including the first gold file', () => {
  const outcome = readUntilGold({ strategy: 'S1', ranked: ['a.py', 'b.py', 'c.py'], gold: ['b.py'], cap: 20, fileTokens, listingTokens: 50 });
  assert.deepEqual([outcome.reached, outcome.tokens, outcome.detail.filesRead], [true, 350, 2]);
});

test('readUntilGold charges for every file read when gold is never reached, and respects the cap', () => {
  const miss = readUntilGold({ strategy: 'S1', ranked: ['a.py', 'b.py', 'c.py'], gold: ['z.py'], cap: 20, fileTokens, listingTokens: 0 });
  assert.deepEqual([miss.reached, miss.tokens], [false, 600]);
  const capped = readUntilGold({ strategy: 'S1', ranked: ['a.py', 'b.py', 'c.py'], gold: ['c.py'], cap: 2, fileTokens, listingTokens: 0 });
  assert.deepEqual([capped.reached, capped.tokens], [false, 300]);
});

test('unreadable files are skipped for free and do not use up the cap; paths are normalised', () => {
  const outcome = readUntilGold({ strategy: 'S1', ranked: ['big.bin', 'nope.py', './a.py'], gold: ['a.py'], cap: 1, fileTokens, listingTokens: 0 });
  assert.deepEqual([outcome.reached, outcome.tokens], [true, 100]);
  assert.equal(readUntilGold({ strategy: 'S1', ranked: [], gold: ['a.py'], cap: 5, fileTokens, listingTokens: 7 }).tokens, 7);
});

test('packOutcome counts shown evidence only: a pointer to a gold file does not reach it', () => {
  const evidence = [{ path: 'x.py', start: 1, end: 9 }, { path: 'a.py', start: 1, end: 9, kind: 'pointer' }];
  assert.equal(packOutcome({ strategy: 'S4', evidence, gold: ['a.py'], packTokens: 3900 }).reached, false);
  assert.equal(packOutcome({ strategy: 'S4', evidence: [...evidence, { path: './a.py', start: 3, end: 4, kind: 'excerpt' }], gold: ['a.py'], packTokens: 3900 }).reached, true);
  assert.equal(packOutcome({ strategy: 'S4', evidence: [], gold: ['a.py'], packTokens: 12 }).tokens, 12);
});

test('chooseFollowUp prefers the first pointer, clamps to 120 lines and survives malformed ranges', () => {
  const evidence = [{ path: 'top.py', start: 5, end: 50 }, { path: 'p1.py', start: 10, end: 500, kind: 'pointer' }, { path: 'p2.py', start: 1, end: 2, kind: 'pointer' }];
  assert.deepEqual(chooseFollowUp(evidence), { path: 'p1.py', start: 10, end: 129, source: 'pointer' });
  assert.deepEqual(chooseFollowUp(evidence.filter(e => !e.kind)), { path: 'top.py', start: 5, end: 50, source: 'top-ranked' });
  assert.deepEqual(chooseFollowUp([{ path: 'w.py', start: Number.NaN, end: Number.NaN }], 10), { path: 'w.py', start: 1, end: 10, source: 'top-ranked' });
  assert.equal(chooseFollowUp([]), null);
});

test('withFollowUp adds the expand tokens and reaches gold only when the expanded file is gold', () => {
  const evidence = [{ path: 'top.py', start: 1, end: 20 }, { path: 'g.py', start: 7, end: 40, kind: 'pointer' }];
  const base = packOutcome({ strategy: 'S4', evidence, gold: ['g.py'], packTokens: 4000 });
  const rangeTokens = (path: string, start: number, end: number) => (path === 'g.py' ? end - start + 1 : null);
  const hit = withFollowUp({ base, strategy: 'S4+expand', evidence, gold: ['g.py'], rangeTokens });
  assert.deepEqual([hit.reached, hit.tokens, hit.strategy], [true, 4034, 'S4+expand']);
  const wrong = withFollowUp({ base: packOutcome({ strategy: 'S4', evidence, gold: ['other.py'], packTokens: 4000 }), strategy: 'S4+expand', evidence, gold: ['other.py'], rangeTokens });
  assert.deepEqual([wrong.reached, wrong.tokens], [false, 4034]);
  const unreadable = withFollowUp({ base, strategy: 'S4+expand', evidence: [{ path: 'gone.py', start: 1, end: 5, kind: 'pointer' }], gold: ['gone.py'], rangeTokens });
  assert.deepEqual([unreadable.reached, unreadable.tokens], [false, 4000]);
});

test('withFollowUp leaves outcomes that already reached gold untouched', () => {
  const evidence = [{ path: 'g.py', start: 1, end: 2 }];
  const base = packOutcome({ strategy: 'S3', evidence, gold: ['g.py'], packTokens: 777 });
  const result = withFollowUp({ base, strategy: 'S3+expand', evidence, gold: ['g.py'], rangeTokens: () => 99999 });
  assert.deepEqual([result.reached, result.tokens], [true, 777]);
});

test('sliceLines is one-based, inclusive, CRLF-agnostic about counts and tolerant of out-of-range requests', () => {
  assert.equal(sliceLines('a\nb\nc\nd', 2, 3), 'b\nc');
  assert.equal(sliceLines('a\nb', 1, 99), 'a\nb');
  assert.equal(sliceLines('a\nb', 5, 9), '');
  assert.equal(sliceLines('a\r\nb\r\nc', 2, 2), 'b\r');
});

test('parsePackSource splits NAME=DIR:VARIANT and rejects malformed input', () => {
  const parsed = parsePackSource('S3=/x/y/main:baseline');
  assert.deepEqual([parsed.name, parsed.dir, parsed.variant], ['S3', '/x/y/main', 'baseline']);
  assert.throws(() => parsePackSource('S3'));
  assert.throws(() => parsePackSource('S3=/x/y:'));
});

test('extractTerms ranks backticked and identifier-shaped words first, ignores stop words, and is deterministic', () => {
  const text = 'When I call `QuerySet.union_all()` after filter, the result is wrong. Expected output differs: parse_header fails with TypeError in handleRequest.';
  const terms = extractTerms(text);
  const names = terms.map(t => t.text);
  assert.deepEqual(names, extractTerms(text).map(t => t.text));
  assert.ok(names.indexOf('union_all') < names.indexOf('filter') || !names.includes('filter'));
  assert.ok(names.includes('parse_header') && names.includes('handleRequest') && names.includes('QuerySet'));
  assert.ok(!names.includes('Expected') && !names.includes('the'));
  assert.ok(terms.find(t => t.text === 'handleRequest')!.identifier);
  assert.equal(extractTerms(text, 3).length, 3);
});

test('extractTerms survives empty, binary-ish, huge and Unicode input without pathological slowness', () => {
  assert.deepEqual(extractTerms(''), []);
  assert.deepEqual(extractTerms('\u0000\u0001 \uFFFD 日本語 ... 123 !!'), []);
  const started = Date.now();
  const huge = `${'a'.repeat(200_000)} ${'x_'.repeat(50_000)} ${'`'.repeat(10_000)}`;
  assert.ok(extractTerms(huge).length <= 10);
  assert.ok(Date.now() - started < 5000);
});

test('parseCountOutput handles ./ prefixes, colons in names and malformed lines', () => {
  const files = parseCountOutput('./a/b.py:3\nweird:name.txt:12\nbroken\n:5\nc.py:0\nd.py:x\n');
  assert.deepEqual([...files], [['a/b.py', 3], ['weird:name.txt', 12]]);
});

test('rankFiles weights rare terms more, drops too-common and absent terms, and breaks ties by path', () => {
  const term = (text: string) => ({ text, identifier: true, score: 1 });
  const common = new Map(Array.from({ length: 400 }, (_, i) => [`m${i}.py`, 1] as [string, number]));
  const hits: TermHits[] = [
    { term: term('rare'), files: new Map([['b.py', 2], ['a.py', 1]]) },
    { term: term('mid'), files: new Map([['a.py', 1], ['c.py', 1], ['d.py', 1], ['e.py', 1]]) },
    { term: term('everywhere'), files: common },
    { term: term('absent'), files: new Map() },
  ];
  const ranking = rankFiles(hits);
  assert.deepEqual(ranking.usedTerms, ['rare', 'mid']);
  assert.deepEqual(ranking.ranked.slice(0, 3), ['a.py', 'b.py', 'c.py']);
  assert.ok(ranking.listing.includes('$ rg -c rare\nb.py:2\na.py:1'));
  assert.ok(!ranking.listing.includes('everywhere'));
});

test('summarize separates reached-only averages from all-instance spend', () => {
  const s = summarize([{ reached: true, tokens: 100 }, { reached: true, tokens: 300 }, { reached: false, tokens: 600 }]);
  assert.deepEqual([s.n, s.reached, s.meanTokens, s.medianTokens, s.tokensPerReached], [3, 2, 200, 200, 500]);
  assert.equal(summarize([{ reached: false, tokens: 5 }]).tokensPerReached, Number.POSITIVE_INFINITY);
  assert.ok(Number.isNaN(summarize([]).reachRate));
});

test('compare: a strategy that is uniformly 5x cheaper has ratio 0.2 with a tight CI and McNemar counts', () => {
  const reference = Array.from({ length: 30 }, (_, i) => ({ reached: true, tokens: 1000 + 50 * i }));
  const cheap = reference.map(r => ({ reached: true, tokens: r.tokens / 5 }));
  const c = compare(cheap, reference, { resamples: 2000, seed: 1 });
  assert.equal(c.bothReached, 30);
  assert.ok(Math.abs(c.geoRatio.value - 0.2) < 1e-9 && c.geoRatio.lo > 0.19 && c.geoRatio.hi < 0.21);
  assert.ok(Math.abs(c.costPerReachRatio.value - 0.2) < 1e-9 && c.costPerReachRatio.hi < 0.21);
  assert.ok(c.meanDiff.value < 0 && c.meanDiff.hi < 0);
  assert.deepEqual([c.reach.onlyA, c.reach.onlyB, c.reach.p], [0, 0, 1]);
});

test('compare counts failed instances as spend and reach differences as McNemar discordance; it is seed-deterministic', () => {
  const reference = Array.from({ length: 20 }, () => ({ reached: false, tokens: 1000 }));
  const strategy = Array.from({ length: 20 }, (_, i) => ({ reached: i < 15, tokens: 100 }));
  const a = compare(strategy, reference, { resamples: 500, seed: 7 });
  const b = compare(strategy, reference, { resamples: 500, seed: 7 });
  assert.deepEqual(a, b);
  assert.equal(a.bothReached, 0);
  assert.ok(Number.isNaN(a.geoRatio.value) || a.geoRatio.value === 1 || Number.isFinite(a.geoRatio.value));
  assert.deepEqual([a.reach.onlyA, a.reach.onlyB, a.reach.diff], [15, 0, 0.75]);
  assert.throws(() => compare(strategy, reference.slice(1)));
});

test('renderTokenCost produces a table with one row per strategy and states failures', () => {
  const costs = { S1: Array.from({ length: 10 }, () => ({ reached: true, tokens: 5000 })), S4: Array.from({ length: 10 }, (_, i) => ({ reached: i !== 0, tokens: 2000 })) };
  const { markdown, json } = renderTokenCost({ costs, order: ['S1', 'S4'], reference: 'S1', n: 10, failures: { S4: 1 }, resamples: 300, seed: 1 });
  assert.match(markdown, /\| S1 \| 10\/10 \(100%\)/);
  assert.match(markdown, /\| S4 \| 9\/10 \(90%\)/);
  assert.match(markdown, /S4=1/);
  assert.ok(json);
});
