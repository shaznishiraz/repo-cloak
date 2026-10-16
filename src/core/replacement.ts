import type { PreviewMatch, Replacement, TextContext } from './ledger.js';
import type { createLocator } from './text.js';

export function applyMatches(text: string, matches: Replacement[], reverse: boolean): string {
  const parts: string[] = [];
  let end = 0;
  for (const match of matches) {
    parts.push(text.slice(end, match.start), reverse ? match.original : match.anonymized);
    end = match.end;
  }
  parts.push(text.slice(end));
  return parts.join('');
}
export function overlaps(a: Replacement, b: Replacement) {
  return a.start < b.end && b.start < a.end;
}
export function secretBoundary(text: string, start: number, end: number): boolean {
  const before = [...text.slice(Math.max(0, start - 2), start)].at(-1) ?? '';
  const code = text.codePointAt(end);
  const after = code === undefined ? '' : String.fromCodePoint(code);
  return !/[\p{L}\p{N}_-]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(after);
}

export function previewMatch(
  match: Replacement,
  context: TextContext,
  locate: ReturnType<typeof createLocator>,
  status: PreviewMatch['status'],
  reason?: PreviewMatch['reason'],
  isNew?: boolean,
): PreviewMatch {
  const preview: PreviewMatch = {
    scope: context.scope,
    kind: match.kind,
    ruleId: match.ruleId,
    file: context.file,
    ...locate(match.start),
    start: match.start,
    end: match.end,
    original: match.kind === 'secret' ? '[secret]' : match.original,
    anonymized: match.anonymized,
    status,
  };
  if (reason) preview.reason = reason;
  if (isNew !== undefined) preview.isNew = isNew;
  return preview;
}

/** Hide skipped fragments too: a boundary failure must never expose part of a key. */
export function maskSecretPreview(preview: PreviewMatch[], secrets: Replacement[]): PreviewMatch[] {
  if (!secrets.length) return preview;
  const ranges: { start: number; end: number }[] = [];
  for (const secret of [...secrets].sort((a, b) => a.start - b.start)) {
    const previous = ranges.at(-1);
    if (previous && secret.start <= previous.end) previous.end = Math.max(previous.end, secret.end);
    else ranges.push({ start: secret.start, end: secret.end });
  }
  let range = 0;
  return [...preview]
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .map((event) => {
      const masked = { ...event };
      for (const secret of secrets)
        masked.file = masked.file.replaceAll(secret.original, '[secret]');
      while (ranges[range] && (ranges[range]?.end ?? 0) <= event.start) range++;
      const span = ranges[range];
      if (span && event.start < span.end && event.end > span.start) {
        masked.original = '[secret]';
        if (event.kind !== 'secret' || event.status !== 'replaced') masked.anonymized = '[secret]';
      }
      return masked;
    });
}
