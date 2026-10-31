/**
 * Token-cost simulation: how many context tokens does an agent consume to *obtain the gold file* of a SWE-bench
 * dev instance with (S1) grep + whole-file reads, or with a context pack from (S2) ripgrep-naive, (S3) 2.1.0, (S4) the final build?
 *
 * Packs come from an earlier `bench/run.ts` run (rows.jsonl + packs); the grep strategies and the follow-up
 * expands are measured here on a pristine checkout of the base commit. This is a proxy for agent behaviour, not a bill.
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { parseDatasetKeys } from '../lib/dataset.js';
import { loadSelection } from '../lib/execute.js';
import { kindOfPath } from '../lib/lang.js';
import { waitForLoad } from '../lib/load.js';
import { normalizePath } from '../lib/metrics.js';
import { CheckoutSlot, prepareRepo } from '../lib/repos.js';
import type { RunRow } from '../lib/report.js';
import { isTestPath } from '../lib/testfiles.js';
import { DEFAULT_RESAMPLES, DEFAULT_SEED } from '../lib/stats.js';
import { expandHome, parsePackSource } from './args.js';
import { packOutcome, readUntilGold, sliceLines, withFollowUp, type Outcome } from './accounting.js';
import { rankFiles, searchTerm } from './grep.js';
import { renderTokenCost } from './render.js';
import { extractTerms } from './terms.js';
import { type InstanceCost } from './summary.js';

const MAX_FILE_BYTES = 1024 * 1024;
const encoder = getEncoding('o200k_base');
const countTokens = (text: string) => encoder.encode(text, [], []).length;

export interface InstanceResult {
  instance_id: string;
  repo: string;
  goldFiles: string[];
  terms: string[];
  usedTerms: string[];
  outcomes: Record<string, Outcome>;
}

const options = {
  dataset: { type: 'string', default: 'lite,multilingual' },
  split: { type: 'string', default: 'dev' },
  repos: { type: 'string' },
  sample: { type: 'string' },
  seed: { type: 'string', default: String(DEFAULT_SEED) },
  pack: { type: 'string', multiple: true },
  cap: { type: 'string', default: '20' },
  'expand-lines': { type: 'string', default: '120' },
  out: { type: 'string' },
  bootstrap: { type: 'string', default: String(DEFAULT_RESAMPLES) },
  'max-load': { type: 'string', default: '40' },
  'report-only': { type: 'boolean', default: false },
} as const;

function loadRows(dir: string, variant: string): Map<string, RunRow> {
  const rows = new Map<string, RunRow>();
  for (const line of readFileSync(join(dir, 'rows.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as RunRow;
    if (row.variant === variant) rows.set(row.instance_id, row);
  }
  return rows;
}

class Reader {
  private cache = new Map<string, string | null>();
  constructor(private root: string) {}

  text(path: string): string | null {
    if (!this.cache.has(path)) {
      let text: string | null = null;
      try {
        const buffer = readFileSync(join(this.root, path));
        if (buffer.length <= MAX_FILE_BYTES && !buffer.includes(0)) text = buffer.toString('utf8');
      } catch {
        // missing or unreadable: the agent cannot read it either
      }
      this.cache.set(path, text);
    }
    return this.cache.get(path)!;
  }

  fileTokens = (path: string): number | null => {
    const text = this.text(path);
    return text === null ? null : countTokens(text);
  };

  rangeTokens = (path: string, start: number, end: number): number | null => {
    const text = this.text(path);
    return text === null ? null : countTokens(`${path}:${start}-${end}\n${sliceLines(text, start, end)}`);
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options, strict: true });
  if (values.split !== 'dev') throw new Error('REFUSING: the token-cost simulation only runs on the DEV split');
  if (!values.out) throw new Error('--out DIR is required');
  if (!values.pack?.length) throw new Error('at least one --pack NAME=DIR:VARIANT is required');
  const out = expandHome(values.out);
  const sources = values.pack.map(parsePackSource);
  const cap = Number(values.cap);
  const expandLines = Number(values['expand-lines']);
  const log = (message: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  await mkdir(out, { recursive: true });
  const file = join(out, 'instances.jsonl');

  if (!values['report-only']) {
    const selection = await loadSelection({
      datasets: parseDatasetKeys(values.dataset as string),
      split: 'dev',
      filters: { repos: values.repos?.split(','), sample: values.sample ? Number(values.sample) : undefined },
      seed: Number(values.seed),
      log,
    });
    const rowSets = sources.map(source => ({ ...source, rows: loadRows(source.dir, source.variant) }));
    const done = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => (JSON.parse(line) as InstanceResult).instance_id) : []);
    const byRepo = new Map<string, typeof selection.selected>();
    for (const instance of selection.selected) byRepo.set(instance.repo, [...(byRepo.get(instance.repo) ?? []), instance]);

    for (const [repo, instances] of byRepo) {
      const todo = instances.filter(instance => !done.has(instance.instanceId));
      if (!todo.length) continue;
      const state = await prepareRepo(repo, todo.map(i => i.baseCommit), { offline: true, log });
      if (state.error || state.missing.length) throw new Error(`${repo}: ${state.error ?? `missing commits ${state.missing.join(',')}`}`);
      const slot = new CheckoutSlot(repo, state.dir, `p${process.pid}-tokencost`);
      try {
        for (const instance of todo) {
          await waitForLoad({ maxLoad: Number(values['max-load']), log });
          await slot.checkout(instance.baseCommit);
          const reader = new Reader(slot.dir);
          const gold = instance.gold.map(g => g.path);
          const terms = extractTerms(instance.statement);
          const hits = [];
          for (const term of terms) hits.push(await searchTerm(slot.dir, term));
          const all = rankFiles(hits);
          const listingTokens = countTokens(all.listing);
          const outcomes: Record<string, Outcome> = {
            'S1': readUntilGold({ strategy: 'S1', ranked: all.ranked, gold, cap, fileTokens: reader.fileTokens, listingTokens }),
            // a more careful grep agent: skips test files and non-code files when choosing what to read
            'S1b': readUntilGold({ strategy: 'S1b', ranked: all.ranked.filter(p => !isTestPath(p) && kindOfPath(p) === 'code'), gold, cap, fileTokens: reader.fileTokens, listingTokens }),
          };
          for (const source of rowSets) {
            const row = source.rows.get(instance.instanceId);
            if (!row || row.status !== 'ok') {
              const failed: Outcome = { strategy: source.name, reached: false, tokens: 0, detail: { failed: row?.status ?? 'missing' } };
              outcomes[source.name] = failed;
              outcomes[`${source.name}+expand`] = { ...failed, strategy: `${source.name}+expand` };
              continue;
            }
            const base = packOutcome({ strategy: source.name, evidence: row.evidence, gold, packTokens: row.outputTokens });
            outcomes[source.name] = base;
            outcomes[`${source.name}+expand`] = withFollowUp({ base, strategy: `${source.name}+expand`, evidence: row.evidence, gold, maxLines: expandLines, rangeTokens: reader.rangeTokens });
          }
          const result: InstanceResult = { instance_id: instance.instanceId, repo, goldFiles: gold.map(normalizePath), terms: terms.map(t => t.text), usedTerms: all.usedTerms, outcomes };
          await appendFile(file, `${JSON.stringify(result)}\n`);
          log(`${instance.instanceId}: ${Object.entries(outcomes).map(([k, o]) => `${k}=${o.reached ? '' : '!'}${o.tokens}`).join(' ')}`);
        }
      } finally {
        await slot.dispose();
      }
    }
  }

  const results = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as InstanceResult);
  const names = [...new Set(results.flatMap(r => Object.keys(r.outcomes)))];
  const costs: Record<string, InstanceCost[]> = Object.fromEntries(names.map(name => [name, results.map(r => ({ reached: r.outcomes[name]?.reached ?? false, tokens: r.outcomes[name]?.tokens ?? 0 }))]));
  const failures = Object.fromEntries(sources.map(s => [s.name, results.filter(r => r.outcomes[s.name]?.detail.failed !== undefined).length]));
  const rendered = renderTokenCost({ costs, order: names, reference: 'S1', n: results.length, failures, resamples: Number(values.bootstrap), seed: Number(values.seed) });
  await writeFile(join(out, 'tokencost.json'), `${JSON.stringify(rendered.json, null, 2)}\n`);
  await writeFile(join(out, 'tokencost.md'), rendered.markdown);
  console.log(rendered.markdown);
  return 0;
}

main().then(code => process.exit(code), error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
