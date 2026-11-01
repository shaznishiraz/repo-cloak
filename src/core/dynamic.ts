import type { CompiledScope, DynamicRule } from './compile.js';
import { RegexLimitError } from './errors.js';
import type { RegexHit, RegexRun } from './regex-engine.js';
import type { PreviewMatch, Replacement, TextContext } from './ledger.js';
import { selectMatches } from './matcher.js';
import { expandReplacement } from './regex.js';
import { overlaps, previewMatch } from './replacement.js';
import { entropy } from './secrets.js';
import type { createLocator } from './text.js';

type DynamicMatch = Replacement & { detector?: string };

type Found = { start: number; end: number; hit?: RegexHit };

function matchesOf(
  compiled: DynamicRule,
  text: string,
  run: RegexRun,
  context: TextContext,
): Found[] {
  const { rule } = compiled;
  if (rule.type === 'regex') {
    try {
      return run(rule.match, rule.flags ?? '', text).map((hit) => ({
        start: hit.index,
        end: hit.index + (hit.captures[0] ?? '').length,
        hit,
      }));
    } catch (cause) {
      if (cause instanceof RegexLimitError)
        throw new RegexLimitError(`${context.file}: ${rule.id}: ${cause.message}`, { cause });
      throw cause;
    }
  }
  if (!('pattern' in compiled)) return [];
  compiled.pattern.lastIndex = 0;
  const found: Found[] = [];
  for (const match of text.matchAll(compiled.pattern)) {
    const range = match.indices?.groups?.secret;
    const start = range?.[0] ?? match.index;
    const end = range?.[1] ?? start + match[0].length;
    if (compiled.entropy && entropy(text.slice(start, end)) < compiled.entropy) continue;
    found.push({ start, end });
  }
  return found;
}

export function findDynamicMatches(
  text: string,
  scope: CompiledScope,
  literals: Replacement[],
  context: TextContext,
  locate: ReturnType<typeof createLocator>,
  run: RegexRun,
) {
  const preview: PreviewMatch[] = [];
  const dynamic: DynamicMatch[] = [];
  for (const compiled of scope.dynamic) {
    const { rule } = compiled;
    for (const match of matchesOf(compiled, text, run, context)) {
      const start = match.start;
      const end = match.end;
      const original = text.slice(start, end);
      if (!original)
        throw new Error(
          `${context.file}:${locate(start).line}: ${rule.id}: empty regex match cannot be restored`,
        );
      let anonymized = '';
      if (match.hit) {
        try {
          anonymized = expandReplacement(rule.type === 'regex' ? rule.replace : '', match.hit);
        } catch (cause) {
          throw new Error(`${context.file}: ${rule.id}: invalid regex replacement`, { cause });
        }
        if (!anonymized)
          throw new Error(`${context.file}: ${rule.id}: empty replacement cannot be restored`);
        if (text.includes(anonymized))
          throw new Error(
            `${context.file}:${locate(start).line}: ${rule.id}: source already contains an anonymized value`,
          );
      }
      const candidate: DynamicMatch = {
        ruleId: rule.id,
        kind: rule.type === 'secret' ? 'secret' : 'regex',
        boundary: 'anywhere',
        start,
        end,
        original,
        anonymized,
      };
      if (rule.type === 'secret') candidate.detector = rule.detector;
      if (literals.some((literal) => overlaps(candidate, literal))) {
        if (rule.type === 'secret')
          throw new Error(
            `${context.file}:${locate(start).line}: ${rule.id}: secret overlaps a literal replacement`,
          );
        preview.push(previewMatch(candidate, context, locate, 'skipped', 'overlap'));
      } else dynamic.push(candidate);
    }
  }
  const dynamicMatches = selectMatches(dynamic);
  for (const match of dynamicMatches.skipped) {
    if (
      match.kind === 'secret' &&
      !dynamicMatches.accepted.some(
        (accepted) =>
          accepted.kind === 'secret' && accepted.start <= match.start && accepted.end >= match.end,
      )
    ) {
      throw new Error(
        `${context.file}:${locate(match.start).line}: ${match.ruleId}: secret overlaps another replacement`,
      );
    }
    preview.push(previewMatch(match, context, locate, 'skipped', 'overlap'));
  }
  return {
    accepted: dynamicMatches.accepted,
    preview,
    secrets: dynamic.filter((match) => match.kind === 'secret'),
  };
}
