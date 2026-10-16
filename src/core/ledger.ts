import { z } from 'zod';
import type { Boundary } from './boundaries.js';

const entrySchema = z.looseObject({
  ruleId: z.string().min(1),
  kind: z.enum(['literal', 'regex', 'secret']),
  scope: z.enum(['content', 'paths']),
  boundary: z.enum(['token', 'word', 'anywhere']),
  original: z.string().min(1),
  anonymized: z.string().min(1),
});
export const ledgerSchema = z.array(entrySchema);
export type LedgerEntry = z.infer<typeof entrySchema>;
export type Ledger = LedgerEntry[];
export type TextContext = { file: string; scope: 'content' | 'paths' };
export type PreviewMatch = {
  scope: TextContext['scope'];
  kind: LedgerEntry['kind'];
  ruleId: string;
  file: string;
  line: number;
  column: number;
  start: number;
  end: number;
  original: string;
  anonymized: string;
  status: 'replaced' | 'skipped';
  reason?: 'boundary' | 'except' | 'overlap';
  isNew?: boolean;
};
export type Replacement = {
  ruleId: string;
  kind: LedgerEntry['kind'];
  boundary: Boundary;
  start: number;
  end: number;
  original: string;
  anonymized: string;
  fromLedger?: boolean;
};

export function validateLedger(value: unknown): Ledger {
  const ledger = ledgerSchema.parse(value);
  const originals = new Map<string, LedgerEntry>();
  const anonymized = new Map<string, LedgerEntry>();
  for (const entry of ledger) {
    const originalKey = JSON.stringify([entry.scope, entry.original]);
    const anonymizedKey = JSON.stringify([entry.scope, entry.anonymized.normalize('NFC')]);
    const forward = originals.get(originalKey);
    const reverse = anonymized.get(anonymizedKey);
    if (
      (forward && forward.anonymized !== entry.anonymized) ||
      (reverse && reverse.original !== entry.original)
    ) {
      throw new Error(
        `${forward?.ruleId ?? reverse?.ruleId} conflicts with ${entry.ruleId}: ambiguous ledger; concrete pairs must be one-to-one`,
      );
    }
    originals.set(originalKey, entry);
    anonymized.set(anonymizedKey, entry);
  }
  return ledger;
}

export function addToLedger(ledger: Ledger, entry: LedgerEntry): void {
  if (
    !ledger.some(
      (pair) =>
        pair.scope === entry.scope &&
        pair.original === entry.original &&
        pair.anonymized === entry.anonymized,
    )
  )
    ledger.push(entry);
}

export function secretPlaceholder(detector: string, original: string, ledger: Ledger): string {
  const prefix = `REDACTED_${detector.replaceAll('-', '_').toUpperCase()}_`;
  const existing = ledger.find(
    (entry) =>
      entry.kind === 'secret' && entry.original === original && entry.anonymized.startsWith(prefix),
  );
  if (existing) return existing.anonymized;
  const numbers = ledger
    .filter((entry) => entry.anonymized.startsWith(prefix))
    .map((entry) => Number(entry.anonymized.slice(prefix.length)))
    .filter(Number.isFinite);
  return `${prefix}${numbers.reduce((highest, number) => Math.max(highest, number), 0) + 1}`;
}
