/**
 * Distinctive search terms of an issue text, as a grep-driven agent would pick them: identifiers first
 * (backticked, snake_case, camelCase, called like `name(`), then long plain words. Deterministic.
 */

const STOP = new Set(
  `about above after again also always because before being below between both bug cannot could does doesn done during each either else error errors
  example expected expect first following from have here however into issue just like make many might more most must need never none only other output
  please problem raise raised returns same should since some such than that their them then there these they this those through trace traceback under
  until using value values version very want were what when where which while will with within without would your actual behavior behaviour current
  steps reproduce description report reported thanks thank code file files line lines python true false none self return import class def print`.split(/\s+/),
);

export interface Term {
  text: string;
  /** Identifier-like: matched case-sensitively; plain words are matched case-insensitively. */
  identifier: boolean;
  score: number;
}

const WORD = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
const BACKTICKED = /`([^`\n]{1,200})`/g;

const isIdentifierShaped = (word: string) => /_/.test(word.replace(/^_+|_+$/g, '')) || /[a-z][A-Z]/.test(word) || /^[A-Z][a-z0-9]+[A-Z]/.test(word) || /^[A-Z0-9_]{4,}$/.test(word);

export function extractTerms(statement: string, max = 10): Term[] {
  const inTicks = new Set<string>();
  for (const match of statement.matchAll(BACKTICKED)) for (const word of match[1].match(WORD) ?? []) inTicks.add(word);

  const stats = new Map<string, { first: number; count: number; called: boolean }>();
  for (const match of statement.matchAll(WORD)) {
    const word = match[0];
    const entry = stats.get(word) ?? { first: match.index ?? 0, count: 0, called: false };
    entry.count++;
    if (statement[(match.index ?? 0) + word.length] === '(') entry.called = true;
    stats.set(word, entry);
  }

  const terms: (Term & { first: number })[] = [];
  for (const [word, entry] of stats) {
    const lower = word.toLowerCase();
    const identifier = isIdentifierShaped(word) || inTicks.has(word) || entry.called;
    if (!identifier && (word.length < 5 || STOP.has(lower))) continue;
    if (identifier && STOP.has(lower)) continue;
    let score = identifier ? 3 : 1;
    if (isIdentifierShaped(word)) score += 1;
    if (inTicks.has(word)) score += 2;
    if (entry.called) score += 1;
    score += Math.min(entry.count - 1, 2) * 0.5;
    terms.push({ text: word, identifier, score, first: entry.first });
  }
  terms.sort((a, b) => b.score - a.score || a.first - b.first || (a.text < b.text ? -1 : 1));
  return terms.slice(0, max).map(({ text, identifier, score }) => ({ text, identifier, score }));
}
