/**
 * The three arms the proof compares on the same gold case.
 *
 * - whole: the agent reads every file in the universe (a ceiling on recall, and the cost of not using any tool).
 * - grep: the agent runs `\bNAME\b`, reads the listing, then opens files in rank order (cap 8 reads).
 * - squeze: the agent asks `Engine.context` for a pack with a 3000-token budget and gets nothing else.
 *
 * Every token count is `tokens(...)` on the text the agent would actually receive.
 */
import type { Engine } from '../../src/engine.js';
import { fileTokens, tokens } from '../../src/tokens.js';
import { packOutcome, readUntilGold } from '../tokencost/accounting.js';
import { shownEvidence } from '../lib/metrics.js';
import { queryFor } from './gold.js';
import type { UniverseFile } from './universe.js';

export const GREP_READ_CAP = 8;
export const GREP_LISTING_LINES = 200;
export const SQUEEZE_BUDGET = 3000;

export interface ArmResult {
  reached: boolean;
  tokens: number;
}

export interface GrepResult extends ArmResult {
  filesRead: number;
  listingTokens: number;
}

export interface SqueezeResult extends ArmResult {
  /** Wall-clock time of `Engine.context` alone, excluding tokenisation. */
  elapsedMs: number;
  /** Shown evidence items (pointers excluded). */
  shown: number;
}

export interface RankedGrep {
  /** Files with at least one match, most matches first, then path. */
  ranked: string[];
  /** The first GREP_LISTING_LINES match lines in path order, `path:line:text`. */
  listing: string;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const identifier = (name: string) => {
  if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`not a plain identifier: ${name}`);
  return name;
};

export function fileCosts(files: UniverseFile[]): Map<string, number> {
  return new Map(files.map(file => [file.path, fileTokens(file.path, file.text)]));
}

export function totalTokens(costs: Map<string, number>): number {
  let sum = 0;
  for (const cost of costs.values()) sum += cost;
  return sum;
}

export function grepFor(files: UniverseFile[], name: string): RankedGrep {
  const pattern = new RegExp(`\\b${identifier(name)}\\b`);
  const counts: Array<{ path: string; count: number }> = [];
  const listed: string[] = [];
  for (const file of [...files].sort((a, b) => byString(a.path, b.path))) {
    let count = 0;
    file.text.split(/\r?\n/).forEach((line, index) => {
      if (!pattern.test(line)) return;
      count++;
      if (listed.length < GREP_LISTING_LINES) listed.push(`${file.path}:${index + 1}:${line}`);
    });
    if (count > 0) counts.push({ path: file.path, count });
  }
  const ranked = counts.sort((a, b) => b.count - a.count || byString(a.path, b.path)).map(item => item.path);
  return { ranked, listing: listed.join('\n') };
}

export function wholeOutcome(gold: string[], costs: Map<string, number>): ArmResult {
  return { reached: gold.some(path => costs.has(path)), tokens: totalTokens(costs) };
}

export function grepOutcome(grep: RankedGrep, gold: string[], costs: Map<string, number>): GrepResult {
  const outcome = readUntilGold({
    strategy: 'grep',
    ranked: grep.ranked,
    gold,
    cap: GREP_READ_CAP,
    fileTokens: path => costs.get(path) ?? null,
    listingTokens: tokens(grep.listing),
  });
  return {
    reached: outcome.reached,
    tokens: outcome.tokens,
    filesRead: Number(outcome.detail.filesRead),
    listingTokens: Number(outcome.detail.listingTokens),
  };
}

export async function squeezeOutcome(engine: Engine, name: string, gold: string[]): Promise<SqueezeResult> {
  const started = performance.now();
  const pack = await engine.context(queryFor(name), SQUEEZE_BUDGET);
  const elapsedMs = performance.now() - started;
  const outcome = packOutcome({ strategy: 'squeze', evidence: pack.evidence, gold, packTokens: tokens(pack.text) });
  return { reached: outcome.reached, tokens: outcome.tokens, elapsedMs, shown: shownEvidence(pack.evidence).length };
}
