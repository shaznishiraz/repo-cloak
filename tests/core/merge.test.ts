import { describe, expect, it } from 'vitest';
import { mergeProfiles } from '../../src/core/merge.js';
import type { SavedProfile } from '../../src/core/profiles.js';
import { validateProfile } from '../../src/core/rules.js';

function saved(id: string, name: string, match = 'Acme', replace = 'Northwind'): SavedProfile {
  return {
    id,
    scope: { kind: 'global' },
    profile: validateProfile({
      kind: 'profile',
      schemaVersion: 1,
      name,
      rules: [{ id: `${name}-rule`, type: 'literal', match, replace }],
    }),
  };
}
describe('profile merging', () => {
  it('rejects a profile selected twice', () => {
    const first = saved('pf_1', 'client');
    expect(() => mergeProfiles([first, first])).toThrow(/client.*twice/);
  });
  it('names both profiles and rules when one original has two replacements', () => {
    expect(() =>
      mergeProfiles([saved('pf_1', 'client'), saved('pf_2', 'other', 'Acme', 'Contoso')]),
    ).toThrow(/client.*client-rule.*other.*other-rule/);
  });
  it('rejects two originals with the same replacement', () => {
    expect(() =>
      mergeProfiles([saved('pf_1', 'client'), saved('pf_2', 'other', 'Contoso', 'Northwind')]),
    ).toThrow(/client.*other/);
  });
  it('deduplicates identical rules even with different ids and explicit defaults', () => {
    const a = saved('pf_1', 'client');
    const b = saved('pf_2', 'other');
    b.profile.rules[0] = {
      ...b.profile.rules[0],
      id: 'other-rule',
      type: 'literal',
      match: 'Acme',
      replace: 'Northwind',
      boundary: 'token',
      styles: 'all',
      enabled: true,
      scope: ['paths', 'content'],
    };
    expect(mergeProfiles([a, b])).toEqual(a.profile.rules);
  });
  it('keeps different scopes with the same profile id distinct', () => {
    const a = saved('pf_1', 'client');
    const b = saved('pf_1', 'other', 'Other', 'Contoso');
    b.scope = { kind: 'repo', repoId: 'a'.repeat(16) };
    expect(mergeProfiles([a, b])).toHaveLength(2);
  });
  it('does not apply disabled rules', () => {
    const a = saved('pf_1', 'client');
    const b = saved('pf_2', 'other', 'Acme', 'Contoso');
    b.profile.rules[0] = {
      ...b.profile.rules[0],
      id: 'off',
      type: 'literal',
      match: 'Acme',
      replace: 'Contoso',
      enabled: false,
    };
    expect(mergeProfiles([a, b])).toEqual(a.profile.rules);
  });
});

it('names both profiles when their generated variants collide', () => {
  expect(() =>
    mergeProfiles([
      saved('pf_1', 'first', 'Acme Corp', 'Northwind Traders'),
      saved('pf_2', 'second', 'AcmeCorp', 'ContosoGroup'),
    ]),
  ).toThrow(/first.*second.*variant collision/);
});
