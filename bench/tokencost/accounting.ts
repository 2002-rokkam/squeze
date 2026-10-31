/**
 * Token accounting for the "tokens to obtain the gold file" simulation.
 *
 * Everything here is pure: file reads and tokenisation are injected, so the bookkeeping can be unit tested
 * without repositories. A strategy's outcome is the number of context tokens an agent would have consumed
 * and whether it ended up having read (part of) a gold file.
 */
import { normalizePath, shownEvidence } from '../lib/metrics.js';

export interface Outcome {
  strategy: string;
  /** A gold file was read (grep agent) or has at least one shown excerpt (packs). */
  reached: boolean;
  /** Context tokens consumed, whether or not the gold file was reached. */
  tokens: number;
  /** Free-form diagnostics (files read, follow-up range, failure reason). */
  detail: Record<string, unknown>;
}

export interface PackEvidence {
  path: string;
  start: number;
  end: number;
  kind?: string;
}

/** Grep-style agent: reads whole files in rank order until a gold file has been read or `cap` files were read. */
export function readUntilGold(options: {
  strategy: string;
  ranked: string[];
  gold: Iterable<string>;
  cap: number;
  /** Tokens of the whole file, or null when the file cannot be read (binary, too large, missing): skipped without cost. */
  fileTokens: (path: string) => number | null;
  /** Tokens of the grep result listing(s) the agent looked at before reading. */
  listingTokens: number;
}): Outcome {
  const gold = new Set([...options.gold].map(normalizePath));
  let tokens = options.listingTokens;
  const read: string[] = [];
  let reached = false;
  for (const ranked of options.ranked) {
    if (read.length >= options.cap) break;
    const path = normalizePath(ranked);
    const cost = options.fileTokens(path);
    if (cost === null) continue;
    tokens += cost;
    read.push(path);
    if (gold.has(path)) {
      reached = true;
      break;
    }
  }
  return { strategy: options.strategy, reached, tokens, detail: { filesRead: read.length, listingTokens: options.listingTokens } };
}

/** An agent that was handed a pack: it consumed the whole pack; gold is reached when a gold file has a shown excerpt. */
export function packOutcome(options: { strategy: string; evidence: PackEvidence[]; gold: Iterable<string>; packTokens: number }): Outcome {
  const gold = new Set([...options.gold].map(normalizePath));
  const reached = shownEvidence(options.evidence).some(item => gold.has(normalizePath(item.path)));
  return { strategy: options.strategy, reached, tokens: options.packTokens, detail: { packTokens: options.packTokens } };
}

export interface FollowUp {
  path: string;
  start: number;
  end: number;
  source: 'pointer' | 'top-ranked';
}

/**
 * The single follow-up `expand` an agent issues when the pack did not show gold: the best-ranked pointer if the
 * pack has any, otherwise the top-ranked evidence item. At most `maxLines` lines are requested.
 */
export function chooseFollowUp(evidence: PackEvidence[], maxLines = 120): FollowUp | null {
  const target = evidence.find(item => item.kind === 'pointer') ?? evidence[0];
  if (!target) return null;
  const start = Number.isFinite(target.start) && target.start >= 1 ? Math.floor(target.start) : 1;
  const wanted = Number.isFinite(target.end) && target.end >= start ? Math.floor(target.end) : start + maxLines - 1;
  return { path: normalizePath(target.path), start, end: Math.min(wanted, start + maxLines - 1), source: target.kind === 'pointer' ? 'pointer' : 'top-ranked' };
}

/** Adds the follow-up expand to a pack outcome that did not reach gold; outcomes that did are returned unchanged. */
export function withFollowUp(options: {
  base: Outcome;
  strategy: string;
  evidence: PackEvidence[];
  gold: Iterable<string>;
  maxLines?: number;
  /** Tokens of lines [start, end] (one-based, inclusive) of the file, or null when unreadable. */
  rangeTokens: (path: string, start: number, end: number) => number | null;
}): Outcome {
  if (options.base.reached) return { ...options.base, strategy: options.strategy, detail: { ...options.base.detail, followUp: null } };
  const followUp = chooseFollowUp(options.evidence, options.maxLines);
  if (!followUp) return { ...options.base, strategy: options.strategy, detail: { ...options.base.detail, followUp: null } };
  const cost = options.rangeTokens(followUp.path, followUp.start, followUp.end);
  const gold = new Set([...options.gold].map(normalizePath));
  const hit = cost !== null && gold.has(followUp.path);
  return {
    strategy: options.strategy,
    reached: hit,
    tokens: options.base.tokens + (cost ?? 0),
    detail: { ...options.base.detail, followUp: { ...followUp, tokens: cost ?? 0 } },
  };
}

/** One-based inclusive line range of `text`, as an agent's ranged read would return it. */
export function sliceLines(text: string, start: number, end: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, start - 1), Math.max(0, end)).join('\n');
}
