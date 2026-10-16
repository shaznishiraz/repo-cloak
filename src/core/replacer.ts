import { hasBoundary, isExcepted } from './boundaries.js';
import { compileScope } from './compile.js';
import { findDynamicMatches } from './dynamic.js';
import { addToLedger, secretPlaceholder, validateLedger } from './ledger.js';
import type { Ledger, PreviewMatch, Replacement, TextContext } from './ledger.js';
import { createMatcher, selectMatches } from './matcher.js';
import { applyMatches, maskSecretPreview, previewMatch } from './replacement.js';
import { restoreText } from './restore.js';
import { validateRule } from './rules.js';
import type { Rule } from './rules.js';
import { ruleSchema } from './schemas.js';
import { createLocator } from './text.js';
import { ruleWarnings } from './variants.js';

const defaultContext: TextContext = { file: 'input', scope: 'content' };
export function createReplacer(input: Rule[]) {
  const rules = input.map((rule) => ruleSchema.parse(rule));
  for (const rule of rules) validateRule(rule);
  const scopes = { content: compileScope(rules, 'content'), paths: compileScope(rules, 'paths') };

  function restore(text: string, ledger: Ledger, context: TextContext = defaultContext) {
    return restoreText(text, ledger, context, scopes[context.scope]);
  }

  function anonymize(
    text: string,
    context: TextContext = defaultContext,
    inputLedger: Ledger = [],
  ) {
    const ledger = validateLedger(inputLedger);
    const scope = scopes[context.scope];
    const locate = createLocator(text);
    const preview: PreviewMatch[] = [];
    const existing = scope.reverse.search(text)[0];
    const prior = createMatcher(
      ledger
        .filter((entry) => entry.scope === context.scope)
        .map((value) => ({ text: value.anonymized, value })),
    ).search(text)[0];
    const placeholder = scope.dynamic.some((entry) => entry.rule.type === 'secret')
      ? /REDACTED_[A-Za-z0-9_-]*/i.exec(text)
      : null;
    const existingOffset = existing?.start ?? prior?.start ?? placeholder?.index;
    if (existingOffset !== undefined) {
      const at = locate(existingOffset);
      throw new Error(
        `${context.file}:${at.line}:${at.column}: source already contains an anonymized value`,
      );
    }
    const literals: Replacement[] = [];
    for (const match of scope.forward.search(text)) {
      const { rule, anonymized } = match.value;
      const candidate: Replacement = {
        ruleId: rule.id,
        kind: 'literal',
        boundary: rule.boundary ?? 'token',
        start: match.start,
        end: match.end,
        original: text.slice(match.start, match.end),
        anonymized,
      };
      const reason = isExcepted(text, match.start, match.end, rule.except ?? [])
        ? 'except'
        : !hasBoundary(text, match.start, match.end, candidate.boundary)
          ? 'boundary'
          : undefined;
      if (reason) preview.push(previewMatch(candidate, context, locate, 'skipped', reason));
      else literals.push(candidate);
    }
    const literalMatches = selectMatches(literals);
    for (const match of literalMatches.skipped)
      preview.push(previewMatch(match, context, locate, 'skipped', 'overlap'));
    const dynamicMatches = findDynamicMatches(
      text,
      scope,
      literalMatches.accepted,
      context,
      locate,
    );
    preview.push(...dynamicMatches.preview);
    const accepted = [...literalMatches.accepted, ...dynamicMatches.accepted].sort(
      (a, b) => a.start - b.start,
    );
    for (const match of accepted) {
      if ('detector' in match && typeof match.detector === 'string')
        match.anonymized = secretPlaceholder(match.detector, match.original, ledger);
      addToLedger(ledger, {
        ruleId: match.ruleId,
        kind: match.kind,
        scope: context.scope,
        boundary: match.boundary,
        original: match.original,
        anonymized: match.anonymized,
      });
      preview.push(previewMatch(match, context, locate, 'replaced'));
    }
    validateLedger(ledger);
    const anonymized = applyMatches(text, accepted, false);
    const verified = restore(anonymized, ledger, context).text;
    if (verified !== text) {
      let index = 0;
      while (index < text.length && verified[index] === text[index]) index++;
      throw new Error(
        `${context.file}:${locate(index).line}: round-trip verification failed; replacements are ambiguous`,
      );
    }
    return {
      text: anonymized,
      ledger,
      preview: maskSecretPreview(
        preview.sort((a, b) => a.start - b.start || b.end - a.end),
        dynamicMatches.secrets,
      ),
    };
  }
  return { anonymize, restore, warnings: ruleWarnings(rules) };
}

export type Replacer = ReturnType<typeof createReplacer>;
