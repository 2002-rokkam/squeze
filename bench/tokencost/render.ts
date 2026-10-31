import { compare, summarize, type Comparison, type InstanceCost, type StrategySummary } from './summary.js';

export interface RenderInput {
  costs: Record<string, InstanceCost[]>;
  order: string[];
  reference: string;
  n: number;
  failures: Record<string, number>;
  resamples: number;
  seed: number;
}

const fmt = (value: number) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : 'n/a');
const ratio = (value: number) => (Number.isFinite(value) ? value.toFixed(3) : 'n/a');
const ci = (r: { value: number; lo: number; hi: number }, f: (v: number) => string) => `${f(r.value)} [${f(r.lo)}, ${f(r.hi)}]`;
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;

export function renderTokenCost(input: RenderInput): { json: unknown; markdown: string } {
  const summaries: Record<string, StrategySummary> = {};
  const comparisons: Record<string, Comparison> = {};
  for (const name of input.order) {
    summaries[name] = summarize(input.costs[name]);
    if (name !== input.reference) comparisons[name] = compare(input.costs[name], input.costs[input.reference], { resamples: input.resamples, seed: input.seed });
  }
  const lines: string[] = [
    `Tokens an agent consumes to obtain a gold file, ${input.n} SWE-bench dev instances (o200k_base). Reference: **${input.reference}**.`,
    '',
    '| strategy | reach | mean tokens (reached) | median tokens (reached) | tokens per reached instance | cost-per-reach vs reference (95% CI) | geo-mean ratio, both reached (95% CI) | reach diff, McNemar p |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const name of input.order) {
    const s = summaries[name];
    const c = comparisons[name];
    lines.push(
      `| ${name} | ${s.reached}/${s.n} (${pct(s.reachRate)}) | ${fmt(s.meanTokens)} | ${fmt(s.medianTokens)} | ${fmt(s.tokensPerReached)} | ${c ? ci(c.costPerReachRatio, ratio) : '1 (reference)'} | ${c ? `${ci(c.geoRatio, ratio)} (n=${c.bothReached})` : '-'} | ${c ? `${c.reach.diff >= 0 ? '+' : ''}${pct(c.reach.diff)}, p=${c.reach.p.toFixed(3)}` : '-'} |`,
    );
  }
  const failed = Object.entries(input.failures).filter(([, count]) => count > 0);
  if (failed.length) lines.push('', `Pack rows that failed or were missing (counted as not reached, 0 tokens): ${failed.map(([k, v]) => `${k}=${v}`).join(', ')}.`);
  return { json: { n: input.n, reference: input.reference, resamples: input.resamples, seed: input.seed, summaries, comparisons, failures: input.failures }, markdown: `${lines.join('\n')}\n` };
}
