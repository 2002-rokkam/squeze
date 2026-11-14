/**
 * Statistics and report rendering for the proof harness. Pure: takes rows, returns numbers and text.
 *
 * Decision rule (fixed before the run): squeze is non-inferior to reading the whole repository when the upper bound of
 * the paired 95% bootstrap interval on (whole recall - squeze recall) is at most NON_INFERIORITY_MARGIN.
 */
import {
  bootstrapMeans,
  DEFAULT_RESAMPLES,
  DEFAULT_SEED,
  mcnemar,
  mulberry32,
  pairedBootstrap,
  quantile,
  type Interval,
  type PairedInterval,
} from '../lib/stats.js';
import type { CaseRow, RepoRun } from './evaluate.js';

export const NON_INFERIORITY_MARGIN = 0.02;

export interface Ratio {
  point: number;
  lo: number;
  hi: number;
}

export interface Summary {
  cases: number;
  recall: { squeeze: Interval; grep: Interval; whole: Interval };
  /** Paired loss = whole recall - squeeze recall. */
  nonInferiority: PairedInterval & { margin: number; pass: boolean };
  versusGrep: { squeezeOnly: number; grepOnly: number; bothHit: number; bothMiss: number; p: number };
  tokens: { squeeze: number; grep: number; whole: number };
  /** 1 - squeeze tokens / grep tokens, resampled over cases. */
  reductionVersusGrep: Ratio;
  /** 1 - squeeze tokens / whole-repository tokens, resampled over cases. */
  reductionVersusWhole: Ratio;
  /** Median of the per-case reduction against grep (cases where grep spent tokens). */
  medianCaseReductionVersusGrep: number;
  /** Cases where squeeze used fewer tokens than grep. */
  squeezeCheaperThanGrep: number;
  latency: { p50Ms: number; p90Ms: number };
  misses: CaseRow[];
}

function ratioReduction(numerator: Float64Array, denominator: Float64Array, seed: number): Ratio {
  const n = numerator.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += numerator[i];
    den += denominator[i];
  }
  const point = 1 - num / den;
  const random = mulberry32(seed);
  const samples = new Float64Array(DEFAULT_RESAMPLES);
  for (let b = 0; b < DEFAULT_RESAMPLES; b++) {
    let sampledNum = 0;
    let sampledDen = 0;
    for (let i = 0; i < n; i++) {
      const k = (random() * n) | 0;
      sampledNum += numerator[k];
      sampledDen += denominator[k];
    }
    samples[b] = 1 - sampledNum / sampledDen;
  }
  return { point, lo: quantile(samples, 0.025), hi: quantile(samples, 0.975) };
}

export function summarize(rows: CaseRow[], seed: number = DEFAULT_SEED): Summary {
  const squeezeHits = Float64Array.from(rows, row => (row.squeeze.reached ? 1 : 0));
  const grepHits = Float64Array.from(rows, row => (row.grep.reached ? 1 : 0));
  const wholeHits = Float64Array.from(rows, row => (row.whole.reached ? 1 : 0));
  const squeezeTokens = Float64Array.from(rows, row => row.squeeze.tokens);
  const grepTokens = Float64Array.from(rows, row => row.grep.tokens);
  const wholeTokens = Float64Array.from(rows, row => row.whole.tokens);
  const latency = Float64Array.from(rows, row => row.squeeze.elapsedMs);
  const caseReductions = rows.filter(row => row.grep.tokens > 0).map(row => 1 - row.squeeze.tokens / row.grep.tokens);

  const [squeezeRecall, grepRecall, wholeRecall] = bootstrapMeans([squeezeHits, grepHits, wholeHits], { seed });
  const paired = pairedBootstrap(squeezeHits, wholeHits, { seed });
  const mc = mcnemar(squeezeHits, grepHits);

  return {
    cases: rows.length,
    recall: { squeeze: squeezeRecall, grep: grepRecall, whole: wholeRecall },
    nonInferiority: { ...paired, margin: NON_INFERIORITY_MARGIN, pass: paired.hi <= NON_INFERIORITY_MARGIN },
    versusGrep: { squeezeOnly: mc.onlyA, grepOnly: mc.onlyB, bothHit: mc.both, bothMiss: mc.neither, p: mc.p },
    tokens: {
      squeeze: squeezeTokens.reduce((sum, value) => sum + value, 0),
      grep: grepTokens.reduce((sum, value) => sum + value, 0),
      whole: wholeTokens.reduce((sum, value) => sum + value, 0),
    },
    reductionVersusGrep: ratioReduction(squeezeTokens, grepTokens, seed),
    reductionVersusWhole: ratioReduction(squeezeTokens, wholeTokens, seed),
    medianCaseReductionVersusGrep: quantile(caseReductions, 0.5),
    squeezeCheaperThanGrep: rows.filter(row => row.squeeze.tokens < row.grep.tokens).length,
    latency: { p50Ms: quantile(latency, 0.5), p90Ms: quantile(latency, 0.9) },
    misses: rows.filter(row => !row.squeeze.reached),
  };
}

export interface ReportInput {
  label: string;
  aggregateOnly: boolean;
  sample: number;
  seed: number;
  runs: RepoRun[];
}

export interface ReportData {
  input: ReportInput;
  pooled: Summary;
  perRepo: Array<{ run: RepoRun; summary: Summary }>;
}

export function buildReport(input: ReportInput): ReportData {
  const rows = input.runs.flatMap(run => run.rows);
  return {
    input,
    pooled: summarize(rows, input.seed),
    perRepo: input.runs.map(run => ({ run, summary: summarize(run.rows, input.seed) })),
  };
}

const pct = (value: number) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a');
const band = (value: { lo: number; hi: number }) => `[${pct(value.lo)}, ${pct(value.hi)}]`;
const count = (value: number) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : 'n/a');
const ms = (value: number) => (Number.isFinite(value) ? `${Math.round(value)}` : 'n/a');
const verdict = (pass: boolean) => (pass ? 'pass' : 'fail');

function excludedLine(excluded: Record<string, number>): string {
  const entries = Object.entries(excluded);
  return entries.length ? entries.map(([reason, total]) => `${reason} ${total}`).join(', ') : 'none';
}

export function renderMarkdown(report: ReportData): string {
  const { input, pooled } = report;
  const lines: string[] = [];
  lines.push(`# Squeze proof: ${input.label}`, '');
  lines.push(
    `Sample: up to ${input.sample} gold cases per repository (seed ${input.seed}). Budget 3000 tokens per pack. ` +
      'Grep arm: 8 whole-file reads, 200 listing lines. Token counts use o200k_base on the text the agent receives.',
    '',
  );

  lines.push('## Verdict', '');
  const ni = pooled.nonInferiority;
  lines.push(
    `- Recall: squeze ${pct(pooled.recall.squeeze.mean)} ${band(pooled.recall.squeeze)} (n=${pooled.cases}); ` +
      `grep ${pct(pooled.recall.grep.mean)} ${band(pooled.recall.grep)}; whole repository ${pct(pooled.recall.whole.mean)} (ceiling).`,
    `- Non-inferiority to whole-repository reading (margin ${pct(ni.margin)}): loss ${pct(ni.diff)} ${band({ lo: ni.lo, hi: ni.hi })}. **${verdict(ni.pass)}**.`,
    `- Tokens per case, pooled: squeeze ${count(pooled.tokens.squeeze)}, grep ${count(pooled.tokens.grep)}, whole ${count(pooled.tokens.whole)}.`,
    `- Reduction versus grep: ${pct(pooled.reductionVersusGrep.point)} ${band(pooled.reductionVersusGrep)}. Median per-case reduction ${pct(pooled.medianCaseReductionVersusGrep)}. Squeeze cheaper in ${pooled.squeezeCheaperThanGrep} of ${pooled.cases} cases.`,
    `- Reduction versus whole repository: ${pct(pooled.reductionVersusWhole.point)} ${band(pooled.reductionVersusWhole)}.`,
    `- Versus grep (McNemar, exact): squeeze-only ${pooled.versusGrep.squeezeOnly}, grep-only ${pooled.versusGrep.grepOnly}, p = ${pooled.versusGrep.p.toFixed(4)}.`,
    `- Squeze pack latency p50 ${ms(pooled.latency.p50Ms)} ms, p90 ${ms(pooled.latency.p90Ms)} ms (warm, after cold index).`,
    '',
  );

  lines.push('## Per repository', '');
  lines.push('| Repository | Files (universe / squeze) | Cases | Squeeze recall | Grep recall | Reduction vs grep | Reduction vs whole | Non-inferior | Cold index ms |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const { run, summary } of report.perRepo) {
    const ni2 = summary.nonInferiority;
    lines.push(
      `| ${run.repo} | ${count(run.universe.files)} / ${run.squeeze.totalFiles === undefined ? 'n/a' : count(run.squeeze.totalFiles)} (${run.squeeze.indexMode ?? 'n/a'}) | ` +
        `${summary.cases} of ${run.availableCases} | ${pct(summary.recall.squeeze.mean)} ${band(summary.recall.squeeze)} | ` +
        `${pct(summary.recall.grep.mean)} | ${pct(summary.reductionVersusGrep.point)} | ${pct(summary.reductionVersusWhole.point)} | ` +
        `${verdict(ni2.pass)} (loss ${pct(ni2.diff)}) | ${ms(run.squeeze.coldIndexMs)} |`,
    );
  }
  lines.push('');

  lines.push('## Losses', '');
  if (input.aggregateOnly) {
    lines.push(`${pooled.misses.length} of ${pooled.cases} cases where squeeze's pack did not show a gold file (names and paths withheld in aggregate-only mode).`, '');
  } else if (pooled.misses.length === 0) {
    lines.push('None in this sample.', '');
  } else {
    lines.push('| Repository | Case | Gold files | Grep reached gold | Grep tokens | Squeeze tokens |', '| --- | --- | --- | --- | --- | --- |');
    for (const row of pooled.misses) {
      lines.push(`| ${row.repo} | ${row.name} | ${row.goldFiles.join(', ')} | ${row.grep.reached ? 'yes' : 'no'} | ${count(row.grep.tokens)} | ${count(row.squeeze.tokens)} |`);
    }
    lines.push('');
  }

  lines.push('## Universe exclusions', '');
  for (const { run } of report.perRepo) lines.push(`- ${run.repo}: ${count(run.universe.listed)} listed; excluded ${excludedLine(run.universe.excluded)}.`);
  lines.push('');

  lines.push('## Method', '');
  lines.push(
    '- Universe: files git lists (tracked and untracked, not ignored), minus tracked files that match an ignore rule, then the same path policy squeze applies, regular files up to 2 MiB, no NUL byte in the first 8 KiB.',
    '- Gold: a name declared at column 0 in one or two universe files (after modifiers) and mentioned in at least two files; length at least 6; not a stopword. The question asked is "Where is NAME defined and how is it used?".',
    '- Whole: the agent reads every universe file. Recall is 1 whenever a gold file is in the universe, so this arm is a ceiling, not a measurement.',
    '- Grep: `\\bNAME\\b` over universe text. Files ranked by match count, then path. The listing is the first 200 match lines in path order; the agent then reads up to 8 files in rank order until it reads a gold file. The ranking is free to grep, which favours grep.',
    '- Squeze: `Engine.context(query, 3000)` with no follow-up `expand`. A case counts as reached when a gold file has a shown excerpt (pointers excluded). Tokens are the pack text.',
    `- Statistics: 95% percentile bootstrap, 10,000 resamples, seed ${input.seed}. Non-inferiority is a paired bootstrap on (whole - squeeze). Token reductions are ratio-of-sums bootstraps over cases.`,
    '',
  );

  lines.push('## Limitations', '');
  lines.push(
    '- Symbol lookups only. Gold covers top-level declarations, not methods, and uses the same declaration pattern family as squeze, which may favour squeze.',
    '- Output tokens and model answer quality are not measured; no model was called.',
    '- Whole-repository recall is trivially 1 for in-universe gold, so non-inferiority reduces to squeze recall within the margin.',
    '- Grep is given a free ranking by match count, which is generous to grep; squeze is not given a follow-up, which is conservative for squeze.',
    '- Results describe this sample and seed. Confidence intervals reflect sampling of cases, not of repositories.',
    '',
  );
  return lines.join('\n');
}

export function renderJson(report: ReportData): object {
  const summaryJson = (summary: Summary) => ({
    cases: summary.cases,
    recall: summary.recall,
    nonInferiority: summary.nonInferiority,
    versusGrep: summary.versusGrep,
    tokens: summary.tokens,
    reductionVersusGrep: summary.reductionVersusGrep,
    reductionVersusWhole: summary.reductionVersusWhole,
    medianCaseReductionVersusGrep: summary.medianCaseReductionVersusGrep,
    squeezeCheaperThanGrep: summary.squeezeCheaperThanGrep,
    latency: summary.latency,
    misses: report.input.aggregateOnly ? summary.misses.length : summary.misses.map(row => ({ repo: row.repo, name: row.name, goldFiles: row.goldFiles, grepReached: row.grep.reached })),
  });
  return {
    label: report.input.label,
    aggregateOnly: report.input.aggregateOnly,
    sample: report.input.sample,
    seed: report.input.seed,
    margin: NON_INFERIORITY_MARGIN,
    pooled: summaryJson(report.pooled),
    repositories: report.perRepo.map(({ run, summary }) => ({
      repo: run.repo,
      universe: { listed: run.universe.listed, files: run.universe.files, excluded: run.universe.excluded, tokens: run.universe.tokens },
      squeeze: run.squeeze,
      availableCases: run.availableCases,
      summary: summaryJson(summary),
    })),
  };
}
