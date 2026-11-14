import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { tokens } from '../src/tokens.js';
import type { CaseRow, RepoRun } from '../bench/proof/evaluate.js';
import { buildGoldCases, declaredNames, queryFor, sampleCases, wordsIn, type GoldCase, type LabelFile } from '../bench/proof/gold.js';
import { grepFor, grepOutcome, squeezeOutcome, wholeOutcome, type RankedGrep } from '../bench/proof/arms.js';
import { checkedTerms, fingerprint, leaks, listedPaths, sensitiveTerms } from '../bench/proof/private.js';
import { buildReport, renderJson, renderMarkdown, summarize, type ReportInput } from '../bench/proof/report.js';
import { buildUniverse, UNIVERSE_MAX_BYTES, type UniverseFile } from '../bench/proof/universe.js';

const cacheDir = await mkdtemp(join(tmpdir(), 'squeze-proof-cache-'));
process.env.REPOSQUEEZE_CACHE_DIR = cacheDir;
after(() => rm(cacheDir, { recursive: true, force: true }));

async function tempDir(t: TestContext, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(root: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    stdio: 'ignore',
  });
}

function universeFile(path: string, text: string, language = 'typescript'): UniverseFile {
  return { path, text, size: Buffer.byteLength(text), language };
}

function caseRow(name: string, goldFiles: string[], squeezeReached: boolean, wholeReached = true): CaseRow {
  return {
    repo: 'fixture',
    name,
    goldFiles,
    whole: { reached: wholeReached, tokens: 1000 },
    grep: { reached: true, tokens: 100, filesRead: 1, listingTokens: 10 },
    squeeze: { reached: squeezeReached, tokens: 3000, elapsedMs: 10, shown: squeezeReached ? 1 : 0 },
  };
}

test('declaredNames reads column-0 declarations across languages', () => {
  const declarations: Array<[string, string[]]> = [
    ['export default function parseConfig(', ['parseConfig']],
    ['async function fetchAll(', ['fetchAll']],
    ['def compute_total(x):', ['compute_total']],
    ['    def helper(self):', []],
    ['func ParseConfig(', ['ParseConfig']],
    ['func (r *Repo) Save()', []],
    ['pub fn parse_config()', ['parse_config']],
    ['pub(crate) fn hidden()', []],
    ['pub struct LedgerEntry {', ['LedgerEntry']],
    ['public final class LedgerService {', ['LedgerService']],
    ['type UserID struct {', ['UserID']],
    ['const MAX_RETRY_COUNT = 3', ['MAX_RETRY_COUNT']],
    ['letter x', []],
    // Names that start with an underscore are not read; this is a documented limit of the pattern.
    ['def _private():', []],
    ['class Ledger {\n  computeTotal() {}\n}', ['Ledger']],
  ];
  for (const [line, names] of declarations) assert.deepEqual(declaredNames(line), names, line);
});

test('wordsIn returns each identifier-like token once', () => {
  assert.deepEqual([...wordsIn('computeTotal(x) + helper_1 + x')].sort(), ['computeTotal', 'helper_1', 'x']);
});

test('buildGoldCases keeps names declared in one or two code files and mentioned in two or more files', () => {
  const files: LabelFile[] = [
    {
      path: 'src/ledger.ts',
      language: 'typescript',
      text: [
        'export function parseLedger() {}',
        'function short() {}',
        'function toString() {}',
        'function sharedHelper() {}',
        'function loneDefinition() {}',
        'const ZetaRunner = 1;',
      ].join('\n'),
    },
    {
      path: 'src/app.ts',
      language: 'typescript',
      text: 'run(parseLedger(), short(), toString(), sharedHelper(), ZetaRunner, alphaRunner);',
    },
    { path: 'src/other.ts', language: 'typescript', text: 'function sharedHelper() {}\nconst alphaRunner = 2;' },
    { path: 'src/third.ts', language: 'typescript', text: 'function sharedHelper() {}' },
    { path: 'notes.md', language: 'text', text: 'function textOnlyName() {}' },
    { path: 'docs/readme.md', language: 'text', text: 'textOnlyName' },
  ];
  assert.deepEqual(buildGoldCases(files), [
    { name: 'ZetaRunner', files: ['src/ledger.ts'] },
    { name: 'alphaRunner', files: ['src/other.ts'] },
    { name: 'parseLedger', files: ['src/ledger.ts'] },
  ]);
});

test('sampleCases is seeded, returns distinct cases, and leaves its input alone', () => {
  const pool: GoldCase[] = Array.from({ length: 50 }, (_, i) => ({ name: `case${i}`, files: [`f${i}.ts`] }));
  const names = pool.map(c => c.name);
  const first = sampleCases(pool, 10, 7);
  assert.deepEqual(sampleCases(pool, 10, 7), first);
  assert.notDeepEqual(sampleCases(pool, 10, 8), first);
  assert.equal(new Set(first.map(c => c.name)).size, 10);
  assert.equal(new Set(sampleCases(pool, 999, 7).map(c => c.name)).size, 50);
  assert.deepEqual(pool.map(c => c.name), names);
});

test('queryFor asks where the name is defined and how it is used', () => {
  assert.equal(queryFor('computeTotal'), 'Where is computeTotal defined and how is it used?');
});

test('grepFor ranks files by match count and lists matches in path order', () => {
  const files = [
    universeFile('a.ts', 'computeTotal()'),
    universeFile('b.ts', 'computeTotal()\ncomputeTotal(x)'),
    universeFile('c.ts', 'computeTotalX()'),
    universeFile('d.ts', '// computeTotal note'),
  ];
  const found = grepFor(files, 'computeTotal');
  assert.deepEqual(found.ranked, ['b.ts', 'a.ts', 'd.ts']);
  assert.equal(
    found.listing,
    'a.ts:1:computeTotal()\nb.ts:1:computeTotal()\nb.ts:2:computeTotal(x)\nd.ts:1:// computeTotal note',
  );
});

test('grepFor caps the listing at 200 lines and rejects names that are not identifiers', () => {
  const big = Array.from({ length: 250 }, () => 'hit').join('\n');
  const found = grepFor([universeFile('big.ts', big)], 'hit');
  assert.equal(found.listing.split('\n').length, 200);
  assert.deepEqual(found.ranked, ['big.ts']);
  assert.throws(() => grepFor([universeFile('a.ts', 'a.b')], 'a.b'), /not a plain identifier: a\.b/);
});

test('grepOutcome reads ranked files until it reads a gold file, and charges the listing once', () => {
  const listing = 'x.ts:1:hit\ngold.ts:1:hit';
  const listingTokens = tokens(listing);
  const costs = new Map([
    ['x.ts', 10],
    ['gold.ts', 20],
  ]);

  const hit: RankedGrep = { ranked: ['x.ts', 'gold.ts'], listing };
  assert.deepEqual(grepOutcome(hit, ['gold.ts'], costs), {
    reached: true,
    tokens: listingTokens + 30,
    filesRead: 2,
    listingTokens,
  });

  const unranked: RankedGrep = { ranked: ['x.ts'], listing };
  assert.deepEqual(grepOutcome(unranked, ['gold.ts'], costs), {
    reached: false,
    tokens: listingTokens + 10,
    filesRead: 1,
    listingTokens,
  });

  const capped: RankedGrep = { ranked: [...Array.from({ length: 10 }, (_, i) => `f${i}.ts`), 'gold.ts'], listing };
  const oneEach = new Map([...Array.from({ length: 10 }, (_, i) => [`f${i}.ts`, 1] as const), ['gold.ts', 20] as const]);
  assert.deepEqual(grepOutcome(capped, ['gold.ts'], oneEach), {
    reached: false,
    tokens: listingTokens + 8,
    filesRead: 8,
    listingTokens,
  });
});

test('wholeOutcome reads every file, so it reaches any gold file in the universe', () => {
  const costs = new Map([
    ['gold.ts', 7],
    ['a.ts', 5],
  ]);
  assert.deepEqual(wholeOutcome(['gold.ts'], costs), { reached: true, tokens: 12 });
  assert.deepEqual(wholeOutcome(['missing.ts'], costs), { reached: false, tokens: 12 });
});

test('squeezeOutcome packs a real Engine and reaches the gold file', async t => {
  const root = await tempDir(t, 'squeeze-proof-engine-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/ledger.ts'), 'export function parseLedger(input: string) {\n  return input.trim();\n}\n');
  await writeFile(join(root, 'src/other.ts'), 'export const unrelated = 42;\n');
  const result = await squeezeOutcome(new Engine(root), 'parseLedger', ['src/ledger.ts']);
  assert.equal(result.reached, true);
  assert.ok(result.shown >= 1);
  assert.ok(result.tokens > 0);
  assert.ok(result.elapsedMs >= 0);
});

test('summarize passes non-inferiority when squeeze matches whole-repository recall', () => {
  const rows = Array.from({ length: 40 }, (_, i) => caseRow(`name${i}`, [`f${i}.ts`], true));
  const summary = summarize(rows);
  assert.equal(summary.cases, 40);
  assert.equal(summary.misses.length, 0);
  assert.equal(summary.nonInferiority.diff, 0);
  assert.equal(summary.nonInferiority.pass, true);
});

test('summarize fails non-inferiority and lists every squeeze miss when half the gold is missed', () => {
  const rows = Array.from({ length: 20 }, (_, i) => caseRow(`name${i}`, [`f${i}.ts`], i < 10));
  const summary = summarize(rows);
  assert.equal(summary.misses.length, 10);
  assert.equal(summary.nonInferiority.pass, false);
  assert.ok(Math.abs(summary.nonInferiority.diff - 0.5) < 0.15, `diff ${summary.nonInferiority.diff}`);
});

function fakeRun(): RepoRun {
  return {
    repo: 'fixture-repo',
    universe: { listed: 2, files: 2, excluded: {}, tokens: 200 },
    squeeze: { totalFiles: 2, indexMode: 'full', coldIndexMs: 12 },
    availableCases: 2,
    rows: [
      {
        repo: 'fixture-repo',
        name: 'zzyUniqueSymbol',
        goldFiles: ['zzy/unique/path.ts'],
        whole: { reached: true, tokens: 100 },
        grep: { reached: true, tokens: 60, filesRead: 1, listingTokens: 10 },
        squeeze: { reached: false, tokens: 40, elapsedMs: 3, shown: 0 },
      },
      {
        repo: 'fixture-repo',
        name: 'alphaHelper',
        goldFiles: ['a.ts'],
        whole: { reached: true, tokens: 100 },
        grep: { reached: true, tokens: 50, filesRead: 1, listingTokens: 10 },
        squeeze: { reached: true, tokens: 40, elapsedMs: 3, shown: 1 },
      },
    ],
  };
}

function reportInput(aggregateOnly: boolean): ReportInput {
  return { label: 'fixture', aggregateOnly, sample: 2, seed: 1729, runs: [fakeRun()] };
}

test('an aggregate-only report names no symbol, path, or folder from the repository', () => {
  const named = buildReport(reportInput(false));
  assert.ok(renderMarkdown(named).includes('zzyUniqueSymbol'), 'control: markdown shows the miss');
  assert.ok(renderMarkdown(named).includes('zzy/unique/path.ts'), 'control: markdown shows the gold path');
  assert.ok(JSON.stringify(renderJson(named)).includes('zzyUniqueSymbol'), 'control: json shows the miss');

  const aggregate = buildReport(reportInput(true));
  const markdown = renderMarkdown(aggregate);
  const json = JSON.stringify(renderJson(aggregate));
  for (const text of [markdown, json]) {
    assert.ok(!text.includes('zzyUniqueSymbol'));
    assert.ok(!text.includes('zzy/unique/path.ts'));
    assert.ok(!text.includes('zzy'));
  }
});

test('sensitiveTerms names the root, its folder, top-level folders, and long relative paths', () => {
  assert.deepEqual(sensitiveTerms('/work/acme-ledger', ['billing/invoice-core.ts', 'README.md']), [
    '/work/acme-ledger',
    'acme-ledger',
    'billing',
    'billing/invoice-core.ts',
  ]);
  assert.deepEqual(sensitiveTerms('/x', ['ab/c.ts']), []);
});

test('leaks matches whole words, paths as substrings, and dots literally', () => {
  assert.deepEqual(leaks('billingX is here', ['billing']), []);
  assert.deepEqual(leaks('see billing now', ['billing']), ['billing']);
  assert.deepEqual(leaks('open src/billing/invoice-core.ts', ['billing/invoice-core.ts']), ['billing/invoice-core.ts']);
  assert.deepEqual(leaks('acmeXledger', ['acme.ledger']), []);
  assert.deepEqual(leaks('uses acme.ledger', ['acme.ledger']), ['acme.ledger']);
});

test('checkedTerms drops terms the public template already contains', () => {
  assert.deepEqual(checkedTerms('/work/acme-ledger', ['billing/invoice-core.ts'], 'template mentions billing here'), [
    '/work/acme-ledger',
    'acme-ledger',
    'billing/invoice-core.ts',
  ]);
});

test('fingerprint is stable while nothing changes and moves when a listed file changes', async t => {
  const root = await tempDir(t, 'squeeze-proof-fp-');
  git(root, ['init', '-q']);
  await writeFile(join(root, 'a.ts'), 'one\n');
  git(root, ['add', 'a.ts']);
  git(root, ['commit', '-qm', 'init']);
  const before = await fingerprint(root);
  assert.equal(await fingerprint(root), before);
  await writeFile(join(root, 'a.ts'), 'two two\n');
  assert.notEqual(await fingerprint(root), before);
});

test('fingerprint refuses a repository with no commits', async t => {
  const root = await tempDir(t, 'squeeze-proof-empty-');
  git(root, ['init', '-q']);
  await assert.rejects(fingerprint(root));
});

test('listedPaths returns tracked and untracked paths in sorted order', async t => {
  const root = await tempDir(t, 'squeeze-proof-listed-');
  git(root, ['init', '-q']);
  await writeFile(join(root, 'b.ts'), 'b\n');
  await writeFile(join(root, 'a.ts'), 'a\n');
  assert.deepEqual(await listedPaths(root), ['a.ts', 'b.ts']);
});

test('buildUniverse keeps the files squeeze would index and names each exclusion', async t => {
  const root = await tempDir(t, 'squeeze-proof-universe-');
  git(root, ['init', '-q']);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'generated'), { recursive: true });
  await writeFile(join(root, '.gitignore'), '*.log\ngenerated/\n');
  await writeFile(join(root, 'src/app.ts'), 'export const app = 1;\n');
  await writeFile(join(root, 'generated/out.ts'), 'export const out = 1;\n');
  await writeFile(join(root, 'gone.ts'), 'export const gone = 1;\n');
  await symlink('src/app.ts', join(root, 'link.ts'));
  await writeFile(join(root, 'src/blob.ts'), Buffer.from([0x41, 0x00, 0x42]));
  git(root, ['add', '.gitignore', 'src/app.ts', 'gone.ts', 'link.ts', 'src/blob.ts']);
  git(root, ['add', '-f', 'generated/out.ts']);
  git(root, ['commit', '-qm', 'init']);

  await unlink(join(root, 'gone.ts'));
  await writeFile(join(root, 'scratch.ts'), 'export const scratch = 1;\n');
  await writeFile(join(root, 'big.txt'), Buffer.alloc(UNIVERSE_MAX_BYTES + 1, 'a'));
  await writeFile(join(root, 'notes.log'), 'ignored\n');

  const universe = await buildUniverse(root);
  assert.equal(universe.listed, 8);
  assert.deepEqual(universe.excluded, {
    'tracked-but-ignored': 1,
    missing: 1,
    'not-regular': 1,
    binary: 1,
    'too-large': 1,
  });
  assert.deepEqual(universe.files.map(f => f.path).sort(), ['.gitignore', 'scratch.ts', 'src/app.ts']);
});
