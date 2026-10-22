import { describe, expect, it } from 'vitest';
import { validateProfile } from '../../src/core/rules.js';
import { profile } from '../fixtures.js';

describe('profile validation', () => {
  it('names duplicate rule ids', () => {
    expect(() =>
      validateProfile({
        ...profile,
        rules: [profile.rules[0], { id: 'company', type: 'secret', detector: 'aws-access-key' }],
      }),
    ).toThrow(/acme.*company.*duplicate/i);
  });
  it('names the rule with an invalid regex', () => {
    expect(() =>
      validateProfile({
        ...profile,
        rules: [{ id: 'bad-regex', type: 'regex', match: '[', replace: 'x' }],
      }),
    ).toThrow(/acme.*bad-regex.*regex/i);
  });
  it('rejects unsupported regex flags and duplicate rules', () => {
    expect(() =>
      validateProfile({
        ...profile,
        rules: [{ id: 'bad-flags', type: 'regex', match: 'x', replace: 'y', flags: 'gy' }],
      }),
    ).toThrow(/bad-flags/);
    expect(() =>
      validateProfile({
        ...profile,
        rules: [profile.rules[0], { ...profile.rules[0], id: 'same-rule' }],
      }),
    ).toThrow(/company.*same-rule.*duplicate/i);
  });
  it('refuses ambiguous reverse mappings within one profile', () => {
    expect(() =>
      validateProfile({
        ...profile,
        rules: [
          ...profile.rules,
          { id: 'other', type: 'literal', match: 'Other', replace: 'Northwind' },
        ],
      }),
    ).toThrow(/company.*other.*same replacement/);
  });
  it('preserves unknown fields and accepts all three rule types', () => {
    const input = {
      ...profile,
      future: { key: true },
      rules: [
        ...profile.rules,
        { id: 'service', type: 'regex', match: 'acme-(\\w+)', flags: 'i', replace: 'northwind-$1' },
        { id: 'keys', type: 'secret', detector: 'aws-access-key' },
      ],
    };
    expect(validateProfile(input)).toEqual(input);
  });
  it('rejects blank profile names and validates disabled rules too', () => {
    expect(() => validateProfile({ ...profile, name: '  ' })).toThrow(/name/i);
    expect(() =>
      validateProfile({
        ...profile,
        rules: [{ id: 'broken', type: 'regex', match: '[', replace: '', enabled: false }],
      }),
    ).toThrow(/broken/);
  });
});

it('rejects unknown detectors and common names without explicit styles during profile validation', () => {
  expect(() =>
    validateProfile({ ...profile, rules: [{ id: 'keys', type: 'secret', detector: 'missing' }] }),
  ).toThrow(/acme\/keys.*unknown/);
  expect(() =>
    validateProfile({
      ...profile,
      rules: [{ id: 'company', type: 'literal', match: 'Meta', replace: 'Northwind' }],
    }),
  ).toThrow(/acme\/company.*styles/);
});

it('validates profile file patterns with the profile and list in the message', () => {
  const base = { kind: 'profile', schemaVersion: 1, name: 'files', rules: [] };
  expect(validateProfile({ ...base, exclude: ['*.schema.json', 'generated/'] }).exclude).toEqual([
    '*.schema.json',
    'generated/',
  ]);
  expect(() => validateProfile({ ...base, exclude: ['../secrets/**'] })).toThrow(
    /files exclude "\.\.\/secrets\/\*\*": pattern cannot point outside/,
  );
  expect(() => validateProfile({ ...base, exclude: ['*.sql', '*.sql'] })).toThrow(
    /duplicate pattern/,
  );
  expect(() =>
    validateProfile({ ...base, include: ['package-lock.json'], exclude: ['package-lock.json'] }),
  ).toThrow(/both include and exclude/);
});
