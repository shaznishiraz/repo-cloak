import { describe, expect, it } from 'vitest';
import { hashJson } from '../../src/core/hash.js';
import { changedProfiles, profileRefs } from '../../src/core/manifest.js';
import type { Snapshot } from '../../src/core/manifest.js';
import { mergeProfiles } from '../../src/core/merge.js';
import type { SavedProfile } from '../../src/core/profiles.js';
import { createReplacer } from '../../src/core/replacer.js';
import { readProfile, validateProfile } from '../../src/core/rules.js';
import { jsonSchema, parseDocument, schemaVersions } from '../../src/core/schemas.js';

const legacy = {
  kind: 'profile',
  schemaVersion: 1,
  name: 'legacy',
  description: 'kept',
  rules: [
    { id: 'c', type: 'literal', match: 'Contoso', replace: 'Northwind' },
    { id: 'r', type: 'regex', match: 'CH-(\\d+)', replace: 'CLM-$1' },
  ],
  exclude: ['*.sql'],
  extensions: { note: 1 },
  unknownField: true,
};
/** Computed by the code before profile@2 existed. Changing it breaks every existing cloak. */
const legacyHash = 'sha256-915ea2089be01eeb1e1f3148a1a391f7d81dedfbec7fc5b3ad5541fa2e82352f';
const v2 = { kind: 'profile', schemaVersion: 2, name: 'v2', rules: [] };
const unsafeRule = { id: 'bad', type: 'regex', match: '(a+)+$', replace: 'x$&' } as const;

describe('profile@2 reading v1', () => {
  it('declares version 2 as current and still reads version 1 as it is', () => {
    expect(schemaVersions.profile).toBe(2);
    expect(parseDocument('profile', legacy)).toEqual(legacy);
  });
  it('keeps the hash a v1 profile had before profile@2, for both readers', () => {
    expect(hashJson(parseDocument('profile', legacy))).toBe(legacyHash);
    expect(hashJson(readProfile(legacy))).toBe(legacyHash);
    expect(hashJson(validateProfile(legacy))).toBe(legacyHash);
  });
  it('does not report a stored v1 profile as changed to an existing cloak', () => {
    const saved: SavedProfile = {
      id: 'pf_1',
      scope: { kind: 'global' },
      profile: readProfile(legacy),
    };
    const previous = {
      data: {
        profiles: [{ id: 'pf_1', name: 'legacy', scope: { kind: 'global' }, hash: legacyHash }],
      },
    } as unknown as Snapshot;
    expect(profileRefs([saved])[0]?.hash).toBe(legacyHash);
    expect(changedProfiles([saved], previous)).toEqual([]);
  });
  it('still refuses a newer version and a version below 1', () => {
    expect(() => parseDocument('profile', { ...v2, schemaVersion: 3 })).toThrow(/newer/);
    expect(() => parseDocument('profile', { ...v2, schemaVersion: 0 })).toThrow(/migration/);
  });
  it('exports both versions and the new fields in the JSON Schema', () => {
    const schema = jsonSchema('profile') as { properties: Record<string, object> };
    expect(schema.properties.schemaVersion).toEqual(expect.objectContaining({ enum: [1, 2] }));
    expect(schema.properties.extends).toBeDefined();
    expect(schema.properties.allowRoots).toBeDefined();
  });
});

describe('profile@2 fields', () => {
  it('accepts extends and allowRoots on version 2 and keeps them', () => {
    const doc = { ...v2, extends: ['base'], allowRoots: ['src/', 'tests/api'] };
    expect(validateProfile(doc)).toEqual(doc);
  });
  it.each([{ extends: ['base'] }, { extends: [] }, { allowRoots: ['src/'] }, { allowRoots: [] }])(
    'refuses %j on version 1 rather than ignore it, while it still opens',
    (fields) => {
      const doc = { ...legacy, ...fields };
      expect(() => validateProfile(doc)).toThrow(/need schemaVersion 2/);
      expect(readProfile(doc)).toEqual(doc);
    },
  );
  it('refuses a malformed root and a blank parent, naming the root', () => {
    expect(() => validateProfile({ ...v2, allowRoots: ['../x'] })).toThrow(/allowRoots "\.\.\/x"/);
    expect(() => validateProfile({ ...v2, extends: [' '] })).toThrow(/blank/);
  });
  it('refuses wrong types at the schema', () => {
    expect(() => readProfile({ ...v2, extends: 'base' })).toThrow();
    expect(() => readProfile({ ...v2, allowRoots: [1] })).toThrow();
    expect(() => readProfile({ ...v2, extends: Array(17).fill('a') })).toThrow();
  });
});

describe('a saved profile with a regex the static check now refuses', () => {
  const doc = { ...legacy, rules: [unsafeRule] };
  const saved: SavedProfile = { id: 'pf_1', scope: { kind: 'global' }, profile: readProfile(doc) };
  it('still opens', () => {
    expect(readProfile(doc).rules).toHaveLength(1);
  });
  it('fails validation naming profile and rule', () => {
    expect(() => validateProfile(doc)).toThrow(/legacy\/bad: unsafe regex: .*nested/);
  });
  it('fails a merge rather than skip the rule', () => {
    expect(() => mergeProfiles([saved])).toThrow(/legacy\/bad: unsafe regex/);
  });
  it('still builds a replacer, because a sealed manifest must keep restoring', () => {
    const replacer = createReplacer([unsafeRule]);
    expect(replacer.restore('plain text', []).text).toBe('plain text');
    const ledger = [
      {
        ruleId: 'bad',
        kind: 'regex' as const,
        scope: 'content' as const,
        boundary: 'anywhere' as const,
        original: 'aaa',
        anonymized: 'xaaa',
      },
    ];
    expect(replacer.restore('see xaaa', ledger).text).toBe('see aaa');
  });
});
