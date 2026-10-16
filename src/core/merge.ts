import { compileVariants } from './variants.js';
import { scopeName } from './profiles.js';
import type { SavedProfile } from './profiles.js';
import { ruleKey, validateProfile } from './rules.js';
import type { Rule } from './rules.js';

type RuleSource = { rule: Rule; label: string };

export function mergeProfiles(profiles: SavedProfile[]): Rule[] {
  const selected = new Set<string>();
  const labels = new Map<Rule, string>();
  const rules = new Map<string, Rule>();
  const originals = new Map<string, RuleSource>();
  const replacements = new Map<string, RuleSource>();
  const patterns = new Map<string, RuleSource>();
  for (const saved of profiles) {
    const name = `${scopeName(saved.scope)}:${saved.profile.name}`;
    const id = `${scopeName(saved.scope)}:${saved.id}`;
    if (selected.has(id)) throw new Error(`${name}: profile selected twice`);
    selected.add(id);
    const profile = validateProfile(saved.profile, name);
    for (const rule of profile.rules) {
      if (rule.enabled === false) continue;
      const label = `${name}/${rule.id}`;
      const current = { rule, label };
      labels.set(rule, label);
      const conflict = (previous: RuleSource, reason: string) => {
        throw new Error(`${previous.label} conflicts with ${label}: ${reason}`);
      };
      if (rule.type === 'literal') {
        const forward = originals.get(rule.match);
        const reverse = replacements.get(rule.replace);
        if (forward?.rule.type === 'literal' && forward.rule.replace !== rule.replace)
          conflict(forward, 'same original, different replacements');
        if (reverse?.rule.type === 'literal' && reverse.rule.match !== rule.match)
          conflict(reverse, 'different originals, same replacement');
        originals.set(rule.match, current);
        replacements.set(rule.replace, current);
      }
      if (rule.type === 'regex') {
        const pattern = JSON.stringify([rule.match, [...(rule.flags ?? '')].sort().join('')]);
        const previous = patterns.get(pattern);
        if (previous?.rule.type === 'regex' && previous.rule.replace !== rule.replace)
          conflict(previous, 'same regex, different replacements');
        patterns.set(pattern, current);
      }
      const key = ruleKey(rule);
      if (!rules.has(key)) rules.set(key, rule);
    }
  }
  const merged = [...rules.values()];
  for (const scope of ['content', 'paths'] as const)
    compileVariants(merged, scope, (rule) => labels.get(rule) ?? rule.id);
  return merged;
}
