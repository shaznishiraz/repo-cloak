import { createMatcher } from './matcher.js';
import type { TextContext } from './ledger.js';
import type { Rule } from './rules.js';
import { getSecretDetector } from './secrets.js';
import { compileVariants, splitWords, usesScope } from './variants.js';

export type DynamicRule = { rule: Rule; pattern: RegExp; entropy: number };

export function compileScope(rules: Rule[], scope: TextContext['scope']) {
  const variants = compileVariants(rules, scope);
  const forward = createMatcher(variants.forward.map((value) => ({ text: value.original, value })));
  const reverse = createMatcher(
    variants.reverse.map((value) => ({ text: value.anonymized, value })),
  );
  const dynamic: DynamicRule[] = [];
  const residue = new Set<string>(variants.reverse.map((pair) => pair.anonymized));
  for (const rule of rules.filter((rule) => usesScope(rule, scope))) {
    if (rule.type === 'literal') {
      const originals = new Set(splitWords(rule.match));
      for (const word of splitWords(rule.replace)) if (!originals.has(word)) residue.add(word);
    } else if (rule.type === 'regex') {
      dynamic.push({ rule, pattern: new RegExp(rule.match, `${rule.flags ?? ''}dg`), entropy: 0 });
    } else {
      const detector = getSecretDetector(rule.detector);
      dynamic.push({
        rule,
        pattern: new RegExp(detector.pattern.source, `${detector.pattern.flags}dg`),
        entropy: detector.entropy ?? 0,
      });
    }
  }
  return { forward, reverse, dynamic, residue: [...residue] };
}

export type CompiledScope = ReturnType<typeof compileScope>;
