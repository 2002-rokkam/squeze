import test, { after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository, RACY_WINDOW_MS } from '../src/repository.js';
import type { Snapshot } from '../src/types.js';

// Keep the persistent index caches out of the user's real cache directory.
const cacheDir = mkdtempSync(join(tmpdir(), 'reposqueeze-freshness-cache-'));
process.env.REPOSQUEEZE_CACHE_DIR = cacheDir;
after(() => rmSync(cacheDir, { recursive: true, force: true }));

const QUERY = 'fn42 return value';
const FILE_COUNT = 60;
const ROUNDS = 4;
const OPS_PER_ROUND = 4;
const OPS = ['same-size-restore', 'same-size-restore', 'grow', 'touch', 'rename', 'delete', 'add'] as const;
type Op = typeof OPS[number];

// Waits past the racy window, so stamps recorded before the wait are trusted by the next scan.
const settle = () => new Promise<void>(done => setTimeout(done, RACY_WINDOW_MS + 500));

// Mulberry32: a seeded generator, so a failing operation sequence replays exactly.
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.keys(vars).map(key => [key, process.env[key]] as const);
  const assign = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  for (const [key, value] of Object.entries(vars)) assign(key, value);
  try { return await run(); } finally { for (const [key, value] of saved) assign(key, value); }
}

const body = (name: string, value: number) => `export function ${name}() {\n  return ${value};\n}\n`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'reposqueeze-freshness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'modules'));
  const model = new Map<string, string>();
  for (let i = 0; i < FILE_COUNT; i++) {
    const path = `modules/m${String(i).padStart(3, '0')}.ts`, text = body(`fn${i}`, i);
    await writeFile(join(root, path), text);
    model.set(path, text);
  }
  return { root, model };
}

// Applies one random edit to disk and to the model that mirrors what the disk should hold.
async function applyOp(op: Op, root: string, model: Map<string, string>, rand: () => number, step: number): Promise<Op> {
  const paths = [...model.keys()].sort();
  const pick = () => paths[Math.floor(rand() * paths.length)];
  const effective: Op = op === 'delete' && paths.length <= 20 ? 'add' : op;
  if (effective === 'add') {
    const path = `modules/added${step}.ts`, text = body(`added${step}`, (step * 7) % 100);
    await writeFile(join(root, path), text);
    model.set(path, text);
    return effective;
  }
  const path = pick(), file = join(root, path), text = model.get(path)!;
  if (effective === 'same-size-restore') {
    const before = await stat(file);
    const digits = [...text.matchAll(/\d/g)].map(match => match.index!);
    const at = digits[Math.floor(rand() * digits.length)];
    const next = text.slice(0, at) + String((Number(text[at]) + 1 + Math.floor(rand() * 8)) % 10) + text.slice(at + 1);
    await writeFile(file, next);
    await utimes(file, before.atime, before.mtime);
    model.set(path, next);
  } else if (effective === 'grow') {
    const next = `${text}// grown at step ${step}\n`;
    await writeFile(file, next);
    model.set(path, next);
  } else if (effective === 'touch') {
    const now = new Date();
    await utimes(file, now, now);
  } else if (effective === 'rename') {
    const next = `modules/renamed${step}.ts`;
    await rename(file, join(root, next));
    model.delete(path);
    model.set(next, text);
  } else {
    await unlink(file);
    model.delete(path);
  }
  return effective;
}

function view(snapshot: Snapshot) {
  return {
    revision: snapshot.revision,
    inventory: [...(snapshot.inventory ?? [])].sort((a, b) => a.path.localeCompare(b.path)),
    files: snapshot.files.map(file => ({ path: file.path, text: file.text })).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function reusedFrom(snapshot: Snapshot): number {
  const match = /([\d,]+) (?:file sketches|indexed files) reused/.exec((snapshot.diagnostics ?? []).join('\n'));
  return match ? Number(match[1].replace(/,/g, '')) : 0;
}

// Ground truth: a snapshot that re-reads every file with an empty cache directory.
async function coldRebuild(root: string): Promise<Snapshot> {
  const dir = await mkdtemp(join(tmpdir(), 'reposqueeze-cold-cache-'));
  try {
    return await withEnv({ REPOSQUEEZE_CACHE_DIR: dir, REPOSQUEEZE_REFRESH_INDEX: '1' }, () => new Repository(root).snapshot(QUERY));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function assertMatchesRebuild(label: string, root: string, snapshot: Snapshot, model: Map<string, string>, mode: 'full' | 'cascade') {
  const rebuilt = await coldRebuild(root);
  assert.equal(snapshot.indexMode, mode, `${label}: index mode`);
  assert.equal(snapshot.totalFiles, model.size, `${label}: file count`);
  assert.deepEqual(view(snapshot), view(rebuilt), label);
}

async function runSeed(t: TestContext, mode: 'full' | 'cascade', seed: number) {
  const { root, model } = await fixture(t);
  const rand = prng(seed);
  const modeEnv = mode === 'cascade'
    ? { REPOSQUEEZE_LARGE_THRESHOLD: '10', REPOSQUEEZE_MAX_CANDIDATES: '100' }
    : { REPOSQUEEZE_LARGE_THRESHOLD: '5000', REPOSQUEEZE_MAX_CANDIDATES: undefined };
  await withEnv({ REPOSQUEEZE_REFRESH_INDEX: undefined, REPOSQUEEZE_EXACT_STATS: undefined, ...modeEnv }, async () => {
    const repo = new Repository(root);
    let trustedReuse = 0, step = 0;
    await settle();
    await assertMatchesRebuild(`seed ${seed} initial`, root, await repo.snapshot(QUERY), model, mode);
    for (let round = 1; round <= ROUNDS; round++) {
      const applied: Op[] = [];
      for (let k = 0; k < OPS_PER_ROUND; k++) {
        // Even rounds open with a same-size edit made after a settled scan: only the change time reveals it.
        const op = k === 0 && round % 2 === 0 ? 'same-size-restore' : OPS[Math.floor(rand() * OPS.length)];
        applied.push(await applyOp(op, root, model, rand, ++step));
      }
      const label = `seed ${seed} round ${round} [${applied.join(', ')}]`;
      if (round % 2 === 1) {
        await assertMatchesRebuild(`${label} racy`, root, await repo.snapshot(QUERY), model, mode);
      }
      await settle();
      const trusted = await repo.snapshot(QUERY);
      trustedReuse += reusedFrom(trusted);
      await assertMatchesRebuild(`${label} trusted`, root, trusted, model, mode);
      const restarted = await new Repository(root).snapshot(QUERY);
      trustedReuse += reusedFrom(restarted);
      await assertMatchesRebuild(`${label} restarted`, root, restarted, model, mode);
    }
    assert(trustedReuse > 0, 'the trusted reuse path must run, or these checks prove nothing about it');
  });
}

test('cascade index matches a cold rebuild across random edits (seed 7)', t => runSeed(t, 'cascade', 7));
test('cascade index matches a cold rebuild across random edits (seed 42)', t => runSeed(t, 'cascade', 42));
test('full index matches a cold rebuild across random edits (seed 7)', t => runSeed(t, 'full', 7));
