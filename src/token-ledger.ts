/**
 * Local record of what each pack returned compared with the full indexed repository.
 * Savings are estimates (repository size minus returned size); they are not billing data.
 */
export const LEDGER_VERSION = 1;
export const LEDGER_CAPACITY = 500;

const MAX_TOOL_NAME = 64;

export interface LedgerEntry {
  /** Epoch milliseconds. */
  at: number;
  tool: string;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
}

export interface LedgerTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
}

export interface PackSample {
  inputTokens: number;
  outputTokens: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const wholeTokens = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

const emptyTotals = (): LedgerTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, savedTokens: 0 });

const entryFrom = (at: number, tool: string, inputTokens: number, outputTokens: number): LedgerEntry => ({
  at,
  tool: tool.slice(0, MAX_TOOL_NAME),
  inputTokens,
  outputTokens,
  savedTokens: Math.max(0, inputTokens - outputTokens),
});

const parseEntry = (value: unknown): LedgerEntry[] => {
  if (!isRecord(value) || typeof value.tool !== 'string') return [];
  const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0;
  return [entryFrom(at, value.tool, wholeTokens(value.inputTokens), wholeTokens(value.outputTokens))];
};

export class TokenLedger {
  private readonly entries: LedgerEntry[];
  private readonly lifetime: LedgerTotals;

  constructor(entries: LedgerEntry[] = [], lifetime: LedgerTotals = emptyTotals()) {
    this.entries = entries.slice(-LEDGER_CAPACITY);
    this.lifetime = { ...lifetime };
  }

  /** Saved tokens never go negative, so a pack larger than the repository counts as zero saved. */
  record(tool: string, sample: PackSample, at: number = Date.now()): LedgerEntry {
    const entry = entryFrom(at, tool, wholeTokens(sample.inputTokens), wholeTokens(sample.outputTokens));
    this.entries.push(entry);
    if (this.entries.length > LEDGER_CAPACITY) this.entries.splice(0, this.entries.length - LEDGER_CAPACITY);
    this.lifetime.calls += 1;
    this.lifetime.inputTokens += entry.inputTokens;
    this.lifetime.outputTokens += entry.outputTokens;
    this.lifetime.savedTokens += entry.savedTokens;
    return { ...entry };
  }

  /** Lifetime totals. They keep counting after old entries are evicted. */
  totals(): LedgerTotals {
    return { ...this.lifetime };
  }

  /** Newest first. */
  recent(limit: number = 10): LedgerEntry[] {
    const count = Math.floor(limit);
    if (!(count > 0)) return [];
    return this.entries.slice(-count).reverse().map(entry => ({ ...entry }));
  }

  toJSON(): { version: number; lifetime: LedgerTotals; entries: LedgerEntry[] } {
    return { version: LEDGER_VERSION, lifetime: this.totals(), entries: this.entries.map(entry => ({ ...entry })) };
  }

  /** Accepts anything read back from storage. Malformed input yields an empty or partial ledger instead of throwing. */
  static fromJSON(value: unknown): TokenLedger {
    if (!isRecord(value) || value.version !== LEDGER_VERSION) return new TokenLedger();
    const entries = Array.isArray(value.entries) ? value.entries.flatMap(parseEntry) : [];
    const stored = isRecord(value.lifetime) ? value.lifetime : {};
    return new TokenLedger(entries, {
      calls: wholeTokens(stored.calls),
      inputTokens: wholeTokens(stored.inputTokens),
      outputTokens: wholeTokens(stored.outputTokens),
      savedTokens: wholeTokens(stored.savedTokens),
    });
  }
}
