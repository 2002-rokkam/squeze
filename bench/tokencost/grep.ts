/**
 * The grep half of the "read whole files" strategy: run ripgrep for each distinctive term, rank files by the
 * rare-term-weighted number of distinct terms they contain, and report the listing an agent would have seen.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizePath } from '../lib/metrics.js';
import type { Term } from './terms.js';

const exec = promisify(execFile);

export interface TermHits {
  term: Term;
  /** path -> number of matching lines */
  files: Map<string, number>;
}

/** Terms matching more files than this are dropped: an agent would refine such a search instead of reading it. */
export const MAX_FILES_PER_TERM = 300;
/** Lines of each `rg -c` listing the agent is assumed to look at. */
export const LISTING_LINES = 40;

export function parseCountOutput(output: string): Map<string, number> {
  const files = new Map<string, number>();
  for (const line of output.split('\n')) {
    const colon = line.lastIndexOf(':');
    if (colon <= 0) continue;
    const count = Number(line.slice(colon + 1));
    if (Number.isInteger(count) && count > 0) files.set(normalizePath(line.slice(0, colon)), count);
  }
  return files;
}

export async function searchTerm(root: string, term: Term): Promise<TermHits> {
  const args = ['--count', '--no-messages', '--no-config', '--max-filesize', '1M', '--fixed-strings', '--word-regexp', ...(term.identifier ? ['--case-sensitive'] : ['--ignore-case']), '--regexp', term.text, '--', '.'];
  try {
    const { stdout } = await exec('rg', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
    return { term, files: parseCountOutput(stdout) };
  } catch (error) {
    // rg exits 1 when nothing matches; anything else (timeout, missing rg) must not look like "no match"
    const failure = error as { code?: number; stdout?: string };
    if (failure.code === 1) return { term, files: new Map() };
    throw error;
  }
}

export interface GrepRanking {
  ranked: string[];
  /** The text an agent would have read in the grep results (one listing per used term). */
  listing: string;
  usedTerms: string[];
}

/** Ranks files by the sum over matched terms of 1 / log2(2 + files matching the term); ties by path. */
export function rankFiles(hits: TermHits[], listingLines = LISTING_LINES, maxFiles = MAX_FILES_PER_TERM): GrepRanking {
  const used = hits.filter(hit => hit.files.size > 0 && hit.files.size <= maxFiles);
  const score = new Map<string, number>();
  const listings: string[] = [];
  for (const hit of used) {
    const weight = 1 / Math.log2(2 + hit.files.size);
    for (const path of hit.files.keys()) score.set(path, (score.get(path) ?? 0) + weight);
    const top = [...hit.files].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, listingLines);
    listings.push(`$ rg -c ${hit.term.text}\n${top.map(([path, count]) => `${path}:${count}`).join('\n')}`);
  }
  const ranked = [...score].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([path]) => path);
  return { ranked, listing: listings.join('\n'), usedTerms: used.map(hit => hit.term.text) };
}
