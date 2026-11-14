/**
 * Proof harness CLI.
 *
 *   node --import tsx bench/proof/run.ts public [--sample 40] [--seed 1729] [--only flask,gin]
 *   node --import tsx bench/proof/run.ts local <path> --label <label> [--sample 40] [--seed 1729]
 *
 * `public` clones the pinned corpus and writes results/public.{json,md}. `local` is read-only and always aggregate-only:
 * it fingerprints the repository before and after, writes nothing into it, and writes nothing at all if the report would
 * contain identifying terms.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_SEED } from '../lib/stats.js';
import { PUBLIC_CORPUS, ensureClone } from './corpus.js';
import { evaluateRepo, type RepoRun } from './evaluate.js';
import { checkedTerms, fingerprint, leaks, listedPaths } from './private.js';
import { buildReport, renderJson, renderMarkdown, type ReportInput } from './report.js';

const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function progress(repo: string) {
  return (done: number, total: number) => {
    if (done === total || done % 10 === 0) process.stderr.write(`[${repo}] ${done}/${total}\n`);
  };
}

/** The public template prose and key names of an aggregate report with no cases, used to tell template words from repository content. */
function templateText(label: string, sample: number, seed: number): string {
  const empty: RepoRun = {
    repo: label,
    universe: { listed: 0, files: 0, excluded: {}, tokens: 0 },
    squeeze: { totalFiles: undefined, indexMode: undefined, coldIndexMs: 0 },
    availableCases: 0,
    rows: [],
  };
  const report = buildReport({ label, aggregateOnly: true, sample, seed, runs: [empty] });
  return `${renderMarkdown(report)}\n${JSON.stringify(renderJson(report))}`;
}

async function writeResults(name: string, input: ReportInput): Promise<void> {
  const report = buildReport(input);
  const markdown = renderMarkdown(report);
  const json = `${JSON.stringify(renderJson(report), null, 2)}\n`;
  await mkdir(RESULTS, { recursive: true });
  await writeFile(join(RESULTS, `${name}.md`), markdown);
  await writeFile(join(RESULTS, `${name}.json`), json);
  process.stdout.write(markdown);
}

async function runPublic(sample: number, seed: number, only: string[] | undefined): Promise<void> {
  const selected = PUBLIC_CORPUS.filter(repo => !only || only.includes(repo.name));
  if (selected.length === 0) throw new Error('--only matched no repositories in the pinned corpus');
  const runs: RepoRun[] = [];
  for (const repo of selected) {
    const root = await ensureClone(repo);
    process.stderr.write(`[${repo.name}] pinned at ${repo.sha.slice(0, 12)}\n`);
    runs.push(await evaluateRepo({ repo: repo.name, root, sample, seed, onProgress: progress(repo.name) }));
  }
  await writeResults('public', {
    label: `public corpus (${selected.length} pinned ${selected.length === 1 ? 'repository' : 'repositories'})`,
    aggregateOnly: false,
    sample,
    seed,
    runs,
  });
}

async function runLocal(path: string, label: string, sample: number, seed: number): Promise<void> {
  const root = resolve(path);
  const before = await fingerprint(root);
  const paths = await listedPaths(root);
  const run = await evaluateRepo({ repo: label, root, sample, seed, onProgress: progress(label) });
  const after = await fingerprint(root);
  if (before !== after) throw new Error('the repository changed during the read-only run; nothing was written');

  const report = buildReport({ label, aggregateOnly: true, sample, seed, runs: [run] });
  const text = `${renderMarkdown(report)}\n${JSON.stringify(renderJson(report))}`;
  const template = templateText(label, sample, seed);
  const terms = checkedTerms(root, paths, template);
  const found = leaks(text, terms);
  if (found.length > 0) throw new Error(`aggregate output contains ${found.length} identifying term(s); nothing was written`);

  await writeResults(label, { label, aggregateOnly: true, sample, seed, runs: [run] });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      sample: { type: 'string' },
      seed: { type: 'string' },
      only: { type: 'string' },
      label: { type: 'string' },
    },
  });
  const [mode, path] = positionals;
  const sample = positiveInteger(values.sample, 40, 'sample');
  const seed = positiveInteger(values.seed, DEFAULT_SEED, 'seed');
  const only = values.only?.split(',').map(name => name.trim()).filter(Boolean);

  const cache = await mkdtemp(join(tmpdir(), 'squeze-proof-cache-'));
  process.env.REPOSQUEEZE_CACHE_DIR = cache;
  try {
    if (mode === 'public') await runPublic(sample, seed, only);
    else if (mode === 'local' && path && values.label) await runLocal(path, values.label, sample, seed);
    else throw new Error('usage: run.ts public [--sample N] [--seed N] [--only a,b] | run.ts local <path> --label <label>');
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
