import { describe, expect, it } from 'vitest';
import {
  documentSchema,
  jsonSchema,
  parseDocument,
  schemaVersions,
} from '../../src/core/schemas.js';

import { profile } from '../fixtures.js';

describe('document schemas', () => {
  it('keeps unknown fields at every level', () => {
    const input = {
      ...profile,
      future: { nested: true },
      rules: [{ ...profile.rules[0], futureRule: [1, 2] }],
      extensions: { vendor: 'value' },
    };
    expect(parseDocument('profile', JSON.parse(JSON.stringify(input)))).toEqual(input);
  });
  it('refuses newer versions with a clear error and source path', () => {
    expect(() =>
      parseDocument('profile', { ...profile, schemaVersion: 99 }, 'profiles/test.json'),
    ).toThrow(/profiles\/test.json.*99.*newer/);
  });
  it('requires a migration for an older version and accepts an explicit migration', () => {
    const old = { ...profile, schemaVersion: 0 };
    expect(() => parseDocument('profile', old)).toThrow(/migration/i);
    expect(
      parseDocument('profile', old, 'old.json', { 0: (value) => ({ ...value, schemaVersion: 1 }) }),
    ).toEqual(profile);
    expect(() => parseDocument('profile', old, 'old.json', { 0: (value) => value })).toThrow(
      /advance/,
    );
  });
  it('rejects malformed and wrong-kind documents', () => {
    expect(() => parseDocument('config', profile)).toThrow();
    expect(() =>
      parseDocument('profile', { ...profile, rules: [{ id: 'x', type: 'literal' }] }),
    ).toThrow();
    expect(() => parseDocument('profile', { ...profile, schemaVersion: 1.5 })).toThrow();
  });
  it.each(['profile', 'repo', 'manifest', 'config'] as const)(
    'exports a JSON Schema for %s',
    (kind) => {
      const schema = jsonSchema(kind);
      expect(schema.$schema).toContain('json-schema.org');
      expect(schema.properties?.kind).toEqual(expect.objectContaining({ const: kind }));
      expect(schema.properties?.schemaVersion).toEqual(
        expect.objectContaining({ const: schemaVersions[kind] }),
      );
      expect(documentSchema[kind]).toBeDefined();
    },
  );
});
