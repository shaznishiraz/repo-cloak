import { parseDocument } from './schemas.js';
import { compileVariants, literalVariants } from './variants.js';
import { getSecretDetector } from './secrets.js';
import type { Document, Rule } from './schemas.js';

export type Profile = Document<'profile'>;
export type { Rule } from './schemas.js';

/** Compare rule settings without their local ids or optional default spelling. */
export function ruleKey(rule: Rule): string {
  const settings: Record<string, unknown> = { ...rule };
  delete settings.id;
  delete settings.enabled;
  const scope = rule.scope ?? ['content', 'paths'];
  settings.scope = [...new Set(typeof scope === 'string' ? [scope] : scope)].sort();
  if (rule.type === 'literal') {
    settings.boundary = rule.boundary ?? 'token';
    settings.styles = Array.isArray(rule.styles) ? [...rule.styles].sort() : 'all';
    settings.forms = [...(rule.forms ?? [])].sort();
    settings.except = [...(rule.except ?? [])].sort();
  }
  if (rule.type === 'regex') settings.flags = [...(rule.flags ?? '')].sort().join('');
  return JSON.stringify(settings, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return value;
  });
}

/** Semantic checks shared by profile editing and engine compilation. */
export function validateRule(rule: Rule, label = rule.id): void {
  if (!rule.id.trim()) throw new Error(`${label}: rule id cannot be blank`);
  if (rule.type === 'regex') {
    try {
      if (!/^[imsu]*$/.test(rule.flags ?? ''))
        throw new Error('Use only i, m, s, u flags; g is implied');
      new RegExp(rule.match, `${rule.flags ?? ''}g`);
    } catch (cause) {
      throw new Error(`${label}: invalid regex or flags`, { cause });
    }
  }
  if (rule.type === 'secret') {
    try {
      getSecretDetector(rule.detector);
    } catch (cause) {
      throw new Error(`${label}: unknown secret detector ${rule.detector}`, { cause });
    }
  }
  if (rule.type === 'literal') {
    try {
      literalVariants(rule);
    } catch (cause) {
      throw new Error(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`, {
        cause,
      });
    }
  }
}

export function validateProfile(value: unknown, source = 'profile'): Profile {
  const profile = parseDocument('profile', value, source);
  if (!profile.name.trim()) throw new Error(`${source}: profile name cannot be blank`);
  const ids = new Set<string>();
  const rules = new Map<string, string>();
  const literals = new Map<string, string>();
  const replacements = new Map<string, string>();
  for (const rule of profile.rules) {
    const label = `${source}: ${profile.name}/${rule.id}`;
    if (!rule.id.trim()) throw new Error(`${label}: rule id cannot be blank`);
    if (ids.has(rule.id)) throw new Error(`${label}: duplicate rule id`);
    ids.add(rule.id);
    validateRule(rule, label);
    const key = ruleKey(rule);
    const previous =
      rules.get(key) ?? (rule.type === 'literal' ? literals.get(rule.match) : undefined);
    if (previous)
      throw new Error(
        `${source}: ${profile.name}/${previous} and ${profile.name}/${rule.id}: duplicate rule`,
      );
    rules.set(key, rule.id);
    if (rule.type === 'literal') {
      const previous = replacements.get(rule.replace);
      if (previous)
        throw new Error(
          `${source}: ${profile.name}/${previous} conflicts with ${profile.name}/${rule.id}: different originals, same replacement`,
        );
      literals.set(rule.match, rule.id);
      replacements.set(rule.replace, rule.id);
    }
  }
  for (const scope of ['content', 'paths'] as const) {
    compileVariants(profile.rules, scope, (rule) => `${source}: ${profile.name}/${rule.id}`);
  }
  return profile;
}
