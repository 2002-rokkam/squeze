/**
 * Gold labels for the proof harness, derived independently of squeze's parser.
 *
 * A label is a top-level declaration: a keyword at column 0, optional modifiers, then the name. A case is kept when the
 * name is declared in one or two universe files and mentioned in at least two universe files, so "where is it defined
 * and how is it used" has a definite answer. Indented declarations (methods) are not labelled; that limits coverage
 * and is reported as such.
 */
import { DEFAULT_SEED, mulberry32 } from '../lib/stats.js';

export const MIN_NAME_LENGTH = 6;
export const MIN_MENTION_FILES = 2;
export const MAX_DECLARING_FILES = 2;
const STOPWORDS = new Set(['constructor', 'toString', 'exports', 'default', 'function', 'interface']);

const MODIFIERS = '(?:(?:export|default|async|pub|public|private|protected|abstract|final|static|sealed|open|inline)\\s+)*';
const KEYWORDS = '(?:function|def|class|func|fn|struct|interface|trait|enum|type|const|let|var)';
const DECLARATION = new RegExp(`^${MODIFIERS}${KEYWORDS}\\s+([A-Za-z][A-Za-z0-9_]*)`, 'gm');
// Word-boundary tokens that cannot start with a digit: the same boundary `\bNAME\b` uses in the grep arm.
const WORD = /\b[A-Za-z_]\w*/g;

export interface LabelFile {
  path: string;
  text: string;
  language: string;
}

export interface GoldCase {
  name: string;
  /** Declaring files, sorted. */
  files: string[];
}

export function declaredNames(text: string): string[] {
  return [...new Set([...text.matchAll(DECLARATION)].map(match => match[1]))];
}

export function wordsIn(text: string): Set<string> {
  return new Set(text.match(WORD) ?? []);
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildGoldCases(files: LabelFile[]): GoldCase[] {
  const declaredIn = new Map<string, Set<string>>();
  const mentionedIn = new Map<string, number>();
  for (const file of files) {
    if (file.language !== 'text') {
      for (const name of declaredNames(file.text)) {
        const paths = declaredIn.get(name) ?? new Set<string>();
        paths.add(file.path);
        declaredIn.set(name, paths);
      }
    }
    for (const word of wordsIn(file.text)) mentionedIn.set(word, (mentionedIn.get(word) ?? 0) + 1);
  }
  const cases: GoldCase[] = [];
  for (const [name, paths] of declaredIn) {
    if (name.length < MIN_NAME_LENGTH || STOPWORDS.has(name)) continue;
    if (paths.size > MAX_DECLARING_FILES) continue;
    if ((mentionedIn.get(name) ?? 0) < MIN_MENTION_FILES) continue;
    cases.push({ name, files: [...paths].sort(byString) });
  }
  return cases.sort((a, b) => byString(a.name, b.name));
}

/** Deterministic partial Fisher-Yates: the same seed and input always pick the same cases. */
export function sampleCases(cases: GoldCase[], count: number, seed = DEFAULT_SEED): GoldCase[] {
  const random = mulberry32(seed);
  const pool = cases.slice();
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

export const queryFor = (name: string) => `Where is ${name} defined and how is it used?`;
