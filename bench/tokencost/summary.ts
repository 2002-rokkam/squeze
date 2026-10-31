/** Summary statistics of the token-cost simulation: per-strategy summaries and paired comparisons against a reference. */
import { DEFAULT_RESAMPLES, DEFAULT_SEED, bootstrapMeans, mcnemar, mean, mulberry32, pairedBootstrap, quantile, type McNemar } from '../lib/stats.js';

export interface InstanceCost {
  reached: boolean;
  tokens: number;
}

export interface StrategySummary {
  n: number;
  reached: number;
  reachRate: number;
  /** Over instances that reached gold only. */
  meanTokens: number;
  medianTokens: number;
  /** All tokens spent on all instances (including failed ones) divided by the number of instances that reached gold. */
  tokensPerReached: number;
}

export function summarize(costs: InstanceCost[]): StrategySummary {
  const reached = costs.filter(c => c.reached);
  const spent = costs.reduce((sum, c) => sum + c.tokens, 0);
  const tokens = reached.map(c => c.tokens);
  return {
    n: costs.length,
    reached: reached.length,
    reachRate: costs.length ? reached.length / costs.length : Number.NaN,
    meanTokens: mean(tokens),
    medianTokens: quantile(tokens, 0.5),
    tokensPerReached: reached.length ? spent / reached.length : Number.POSITIVE_INFINITY,
  };
}

export interface Comparison {
  /** Instances where both strategies reached gold. */
  bothReached: number;
  /** Mean of (strategy - reference) tokens over both-reached instances, with paired-bootstrap 95% CI. */
  meanDiff: { value: number; lo: number; hi: number };
  /** Geometric mean of strategy/reference tokens over both-reached instances (1 = same, 0.2 = five times cheaper). */
  geoRatio: { value: number; lo: number; hi: number };
  /** (tokens spent / instances reached) of the strategy divided by the reference's; instances are resampled jointly. */
  costPerReachRatio: { value: number; lo: number; hi: number };
  /** Reach rate difference (strategy - reference) and exact McNemar test (A = strategy). */
  reach: McNemar & { diff: number };
}

function costPerReach(costs: InstanceCost[], indices: ArrayLike<number>): number {
  let spent = 0;
  let reached = 0;
  for (let i = 0; i < indices.length; i++) {
    const c = costs[indices[i]];
    spent += c.tokens;
    if (c.reached) reached++;
  }
  return reached ? spent / reached : Number.NaN;
}

export function compare(strategy: InstanceCost[], reference: InstanceCost[], options: { resamples?: number; seed?: number } = {}): Comparison {
  if (strategy.length !== reference.length) throw new Error('strategies must be evaluated on the same instances');
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const seed = options.seed ?? DEFAULT_SEED;
  const both = strategy.map((s, i) => [s, reference[i]] as const).filter(([s, r]) => s.reached && r.reached && s.tokens > 0 && r.tokens > 0);

  const diff = pairedBootstrap(both.map(([, r]) => r.tokens), both.map(([s]) => s.tokens), { resamples, seed });
  const logs = Float64Array.from(both.map(([s, r]) => Math.log(s.tokens / r.tokens)));
  const [log] = bootstrapMeans([logs], { resamples, seed });

  const n = strategy.length;
  const random = mulberry32(seed);
  const indices = new Int32Array(n);
  const ratios: number[] = [];
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) indices[i] = (random() * n) | 0;
    const ratio = costPerReach(strategy, indices) / costPerReach(reference, indices);
    if (Number.isFinite(ratio)) ratios.push(ratio);
  }
  ratios.sort((a, b) => a - b);
  const all = Int32Array.from({ length: n }, (_, i) => i);
  const pick = (q: number) => (ratios.length ? ratios[Math.min(ratios.length - 1, Math.floor(q * ratios.length))] : Number.NaN);

  const test = mcnemar(strategy.map(s => s.reached), reference.map(r => r.reached));
  return {
    bothReached: both.length,
    meanDiff: { value: diff.diff, lo: diff.lo, hi: diff.hi },
    geoRatio: { value: Math.exp(log.mean), lo: Math.exp(log.lo), hi: Math.exp(log.hi) },
    costPerReachRatio: { value: costPerReach(strategy, all) / costPerReach(reference, all), lo: pick(0.025), hi: pick(0.975) },
    reach: { ...test, diff: (test.onlyA - test.onlyB) / n },
  };
}
