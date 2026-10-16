import { hasBoundary } from './boundaries.js';
import type { CompiledScope } from './compile.js';
import { validateLedger } from './ledger.js';
import type { Ledger, Replacement, TextContext } from './ledger.js';
import { createMatcher, selectMatches } from './matcher.js';
import { applyMatches, maskSecretPreview, previewMatch, secretBoundary } from './replacement.js';
import { createLocator, location } from './text.js';

export function restoreText(
  text: string,
  inputLedger: Ledger,
  context: TextContext,
  scope: CompiledScope,
) {
  const ledger = validateLedger(inputLedger).filter((entry) => entry.scope === context.scope);
  const candidates: Replacement[] = [];
  const exact = createMatcher(ledger.map((value) => ({ text: value.anonymized, value })));
  for (const match of exact.search(text)) {
    const entry = match.value;
    if (!hasBoundary(text, match.start, match.end, entry.boundary)) continue;
    if (entry.kind === 'secret' && !secretBoundary(text, match.start, match.end)) continue;
    candidates.push({ ...entry, start: match.start, end: match.end, fromLedger: true });
  }
  for (const match of scope.reverse.search(text)) {
    const { rule, original, anonymized } = match.value;
    if (!hasBoundary(text, match.start, match.end, rule.boundary ?? 'token')) continue;
    candidates.push({
      ruleId: rule.id,
      kind: 'literal',
      boundary: rule.boundary ?? 'token',
      start: match.start,
      end: match.end,
      original,
      anonymized,
      fromLedger: false,
    });
  }
  const { accepted } = selectMatches(candidates);
  const restored = applyMatches(text, accepted, true);
  const placeholder = /REDACTED_[A-Za-z0-9_-]*/i.exec(restored);
  if (placeholder) {
    const at = location(restored, placeholder.index);
    throw new Error(
      `${context.file}:${at.line}:${at.column}: unknown or altered secret placeholder`,
    );
  }
  const terms = [
    ...scope.residue,
    ...ledger.filter((entry) => entry.kind !== 'secret').map((entry) => entry.anonymized),
  ];
  if (terms.length) {
    const residue = createMatcher(
      terms.map((text) => ({ text, value: true })),
      { foldCase: true },
    ).search(restored)[0];
    if (residue) {
      const at = location(restored, residue.start);
      throw new Error(
        `${context.file}:${at.line}:${at.column}: anonymized text remains after restoration`,
      );
    }
  }
  const locate = createLocator(text);
  const preview = accepted.map((match) =>
    previewMatch(match, context, locate, 'replaced', undefined, !match.fromLedger),
  );
  return {
    text: restored,
    preview: maskSecretPreview(
      preview,
      accepted.filter((match) => match.kind === 'secret'),
    ),
  };
}
