import type { CompiledScope } from './compile.js';
import type { PreviewMatch, Replacement, TextContext } from './ledger.js';
import { selectMatches } from './matcher.js';
import { expandReplacement } from './regex.js';
import { overlaps, previewMatch } from './replacement.js';
import { entropy } from './secrets.js';
import type { createLocator } from './text.js';

type DynamicMatch = Replacement & { detector?: string };

export function findDynamicMatches(
  text: string,
  scope: CompiledScope,
  literals: Replacement[],
  context: TextContext,
  locate: ReturnType<typeof createLocator>,
) {
  const preview: PreviewMatch[] = [];
  const dynamic: DynamicMatch[] = [];
  for (const compiled of scope.dynamic) {
    const { rule, pattern } = compiled;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const range = rule.type === 'secret' ? match.indices?.groups?.secret : undefined;
      const start = range?.[0] ?? match.index;
      const end = range?.[1] ?? start + match[0].length;
      const original = text.slice(start, end);
      if (compiled.entropy && entropy(original) < compiled.entropy) continue;
      if (!original)
        throw new Error(
          `${context.file}:${locate(start).line}: ${rule.id}: empty regex match cannot be restored`,
        );
      let anonymized = '';
      if (rule.type === 'regex') {
        try {
          anonymized = expandReplacement(rule.replace, match);
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
