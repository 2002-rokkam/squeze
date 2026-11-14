import type { LedgerEntry, LedgerTotals } from './token-ledger.js';

const UNSAFE_CELL = /[^A-Za-z0-9_.:-]/g;

/** Compact token or file counts for the status bar: 950, 1.2k, 12k, 1.2M. */
export function compactCount(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  if (n < 1000) return String(n);
  if (n < 999_500) return trimmed(n / 1000) + 'k';
  return trimmed(n / 1_000_000) + 'M';
}

function trimmed(value: number): string {
  const text = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return text.replace(/\.0$/, '');
}

export function indexedStatus(files: number, savedTokens: number): string {
  return `$(graph) Squeze · ${files.toLocaleString('en-US')} files · ~${compactCount(savedTokens)} saved`;
}

/** Markdown report of the workspace ledger. Every number is an estimate; tool names are sanitised before rendering. */
export function ledgerMarkdown(totals: LedgerTotals, recent: readonly LedgerEntry[]): string {
  const reduction = totals.inputTokens > 0 ? (totals.savedTokens / totals.inputTokens) * 100 : 0;
  const lines = [
    '# Squeze token ledger',
    '',
    'Estimates for pack calls in this workspace. These are not billing figures: the full-repository size is an estimate of the indexed repository, and the returned size is the pack Squeze sent back.',
    '',
    '| Measure | Value |',
    '|---|---|',
    `| Pack calls | ${number(totals.calls)} |`,
    `| Full repository (est. tokens) | ${number(totals.inputTokens)} |`,
    `| Returned (tokens) | ${number(totals.outputTokens)} |`,
    `| Saved (est. tokens) | ${number(totals.savedTokens)} |`,
    `| Reduction | ${reduction.toFixed(1)}% |`,
    '',
  ];
  if (recent.length === 0) {
    lines.push('No pack calls recorded yet.');
  } else {
    lines.push('## Recent calls', '', '| Time (UTC) | Tool | Returned | Saved |', '|---|---|---|---|');
    for (const entry of recent) {
      lines.push(`| ${timeOf(entry.at)} | ${cell(entry.tool)} | ${number(entry.outputTokens)} | ${number(entry.savedTokens)} |`);
    }
  }
  return lines.join('\n') + '\n';
}

function number(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function timeOf(at: number): string {
  return at > 0 ? new Date(at).toISOString().slice(0, 19).replace('T', ' ') : '—';
}

function cell(text: string): string {
  return text.replace(UNSAFE_CELL, '?');
}
