import { words } from 'lodash-es';
import type { Rule } from './rules.js';

export type LiteralRule = Extract<Rule, { type: 'literal' }>;
export type Variant = { rule: LiteralRule; original: string; anonymized: string };
export type RuleWarning = {
  ruleId: string;
  code: 'short-name' | 'weak-replacement';
  message: string;
};
type Casing = 'lower' | 'upper' | 'title' | 'camel';
type Style = { casing: Casing; separator: string };

const commonWords = new Set([
  'apple',
  'meta',
  'square',
  'data',
  'client',
  'service',
  'server',
  'system',
  'token',
  'key',
  'code',
  'cloud',
  'team',
  'group',
  'project',
]);
const namedStyles: Record<string, Style> = {
  lower: { casing: 'lower', separator: '' },
  upper: { casing: 'upper', separator: '' },
  title: { casing: 'title', separator: ' ' },
  pascal: { casing: 'title', separator: '' },
  camel: { casing: 'camel', separator: '' },
  snake: { casing: 'lower', separator: '_' },
  screaming: { casing: 'upper', separator: '_' },
  kebab: { casing: 'lower', separator: '-' },
  dot: { casing: 'lower', separator: '.' },
  spaced: { casing: 'title', separator: ' ' },
  smushed: { casing: 'lower', separator: '' },
};
const allStyles: Style[] = ['', '_', '-', '.', ' ', '/'].flatMap((separator) =>
  (['lower', 'upper', 'title', 'camel'] as const).map((casing) => ({ casing, separator })),
);

export function splitWords(text: string): string[] {
  return words(text.normalize('NFC')).map((word) => word.toLowerCase());
}
function title(word: string): string {
  const first = [...word][0] ?? '';
  return first.toUpperCase() + word.slice(first.length).toLowerCase();
}
function render(parts: string[], style: Style): string {
  return parts
    .map((part, index) => {
      if (style.casing === 'upper') return part.toUpperCase();
      if (style.casing === 'title' || (style.casing === 'camel' && index > 0)) return title(part);
      return part.toLowerCase();
    })
    .join(style.separator);
}
function formStyle(form: string): Style {
  const separator = form.match(/[_\-. /]/u)?.[0] ?? '';
  if (form === form.toUpperCase()) return { casing: 'upper', separator };
  if (form === form.toLowerCase()) return { casing: 'lower', separator };
  const first = [...form][0] ?? '';
  return { casing: first === first.toLowerCase() ? 'camel' : 'title', separator };
}

export function literalVariants(rule: LiteralRule) {
  const original = splitWords(rule.match);
  const anonymized = splitWords(rule.replace);
  if (!original.length || !anonymized.length)
    throw new Error(`${rule.id}: literal names must contain letters or numbers`);
  if (
    commonWords.has(rule.match.toLowerCase()) &&
    rule.common !== false &&
    (!rule.styles || rule.styles === 'all')
  ) {
    throw new Error(`${rule.id}: common name requires explicit styles (or common: false)`);
  }
  const styles = Array.isArray(rule.styles)
    ? rule.styles
        .map((style) => namedStyles[style])
        .filter((style): style is Style => style !== undefined)
    : allStyles;
  const pairs: Variant[] = styles.map((style) => ({
    rule,
    original: render(original, style),
    anonymized: render(anonymized, style),
  }));
  const exact = rule.match.normalize('NFC');
  if ((!rule.styles || rule.styles === 'all') && !pairs.some((pair) => pair.original === exact)) {
    pairs.push({ rule, original: exact, anonymized: rule.replace.normalize('NFC') });
  }
  for (const form of rule.forms ?? []) {
    const original = form.normalize('NFC');
    const pair = { rule, original, anonymized: render(anonymized, formStyle(form)) };
    const existing = pairs.findIndex((pair) => pair.original === original);
    if (existing >= 0) pairs[existing] = pair;
    else pairs.push(pair);
  }
  // Aliases can share an original spelling when word counts differ. The first
  // forward rendering wins; all reverse spellings remain available for new code.
  const forward = new Map<string, Variant>();
  const reverse = new Map<string, Variant>();
  for (const pair of pairs) {
    if (!forward.has(pair.original)) forward.set(pair.original, pair);
    if (!reverse.has(pair.anonymized)) reverse.set(pair.anonymized, pair);
  }
  return { forward: [...forward.values()], reverse: [...reverse.values()] };
}

export function usesScope(rule: Rule, scope: 'content' | 'paths'): boolean {
  if (rule.enabled === false) return false;
  return (
    !rule.scope ||
    (typeof rule.scope === 'string' ? rule.scope === scope : rule.scope.includes(scope))
  );
}

export function compileVariants(
  rules: Rule[],
  scope: 'content' | 'paths',
  label = (rule: Rule) => rule.id,
) {
  const forward: Variant[] = [];
  const reverse: Variant[] = [];
  const originals = new Map<string, LiteralRule>();
  const anonymized = new Map<string, LiteralRule>();
  for (const rule of rules) {
    if (rule.type !== 'literal' || !usesScope(rule, scope)) continue;
    const variants = literalVariants(rule);
    for (const pair of variants.forward) {
      const previous = originals.get(pair.original);
      if (previous && previous !== rule)
        throw new Error(
          `${label(previous)} conflicts with ${label(rule)}: original variant collision`,
        );
      originals.set(pair.original, rule);
      if (pair.original === pair.anonymized)
        throw new Error(`${label(rule)}: original and anonymized names must differ`);
    }
    for (const pair of variants.reverse) {
      const previous = anonymized.get(pair.anonymized);
      if (previous && previous !== rule)
        throw new Error(
          `${label(previous)} conflicts with ${label(rule)}: anonymized variant collision`,
        );
      anonymized.set(pair.anonymized, rule);
    }
    forward.push(...variants.forward);
    reverse.push(...variants.reverse);
  }
  return { forward, reverse };
}

export function ruleWarnings(rules: Rule[]): RuleWarning[] {
  const warnings: RuleWarning[] = [];
  for (const rule of rules) {
    if (rule.type !== 'literal' || rule.enabled === false) continue;
    if ([...rule.match].length < 4)
      warnings.push({
        ruleId: rule.id,
        code: 'short-name',
        message: 'Short names need careful boundary selection',
      });
    if ([...rule.replace].length < 4 || commonWords.has(rule.replace.toLowerCase()))
      warnings.push({
        ruleId: rule.id,
        code: 'weak-replacement',
        message: 'Use a distinctive replacement to avoid restoring unrelated code',
      });
  }
  return warnings;
}
