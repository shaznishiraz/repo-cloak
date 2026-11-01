import { expect, it } from 'vitest';
import {
  applyChanges,
  diffProfiles,
  duplicateLines,
  lineChanges,
  lineOfPath,
  moveLines,
  outlineOf,
  parseProblem,
  pretty,
} from '../../src/web/screens/profiles/document.js';
import {
  addRule,
  asProfileDoc,
  blankProfile,
  exactPattern,
  exclusionPresets,
  presetActive,
  removeRule,
  rowOf,
  togglePreset,
  updateRow,
} from '../../src/web/screens/profiles/rules.js';
import type { ExclusionPreset, ProfileDoc, RuleDoc } from '../../src/web/screens/profiles/rules.js';

const first = (doc: ProfileDoc) => doc.rules[0] as RuleDoc;

const base = (): ProfileDoc => ({
  ...blankProfile(),
  name: 'names',
  rules: [{ id: 'a', type: 'literal', match: 'Contoso', replace: 'Northwind' }],
});

it('adds a rule of each type with a stable id and a label', () => {
  let doc = blankProfile();
  for (const kind of ['brand', 'keyword', 'term', 'regex', 'secret'] as const)
    doc = addRule(doc, kind);
  expect(doc.rules.map((rule) => rule.type)).toEqual([
    'literal',
    'literal',
    'literal',
    'regex',
    'secret',
  ]);
  expect(doc.rules.map((rule) => rowOf(doc, rule).kind)).toEqual([
    'brand',
    'keyword',
    'term',
    'regex',
    'secret',
  ]);
  expect(new Set(doc.rules.map((rule) => rule.id)).size).toBe(5);
  expect(doc.rules[4]).toEqual({ id: 'secret-5', type: 'secret', detector: 'api-key' });
});

it('keeps labels out of the rule, so they cannot change how profiles merge', () => {
  const doc = addRule(base(), 'term', 'Medicaid');
  const added = doc.rules[1];
  expect(added && 'kind' in added).toBe(false);
  expect(doc.extensions).toEqual({ ruleKinds: { [added?.id ?? '']: 'term' } });
  expect(removeRule(doc, added?.id ?? '').extensions).toBeUndefined();
});

it('reads a stored literal with no label as a brand that preserves case', () => {
  const doc = base();
  expect(rowOf(doc, first(doc))).toMatchObject({
    kind: 'brand',
    find: 'Contoso',
    replace: 'Northwind',
    caseMode: 'preserve',
  });
});

it('stores exact case as a bounded regex and shows it as plain text again', () => {
  const doc = updateRow(
    updateRow(base(), 'a', { find: 'contoso-health.com', replace: 'a$1.example' }),
    'a',
    { caseMode: 'exact' },
  );
  const rule = first(doc);
  expect(rule).toMatchObject({
    type: 'regex',
    match: exactPattern('contoso-health.com'),
    replace: 'a$$1.example',
  });
  expect(new RegExp(rule.match ?? '').test('at contoso-health.com/x')).toBe(true);
  expect(new RegExp(rule.match ?? '').test('xcontoso-health.com')).toBe(false);
  expect(rowOf(doc, rule)).toMatchObject({
    caseMode: 'exact',
    find: 'contoso-health.com',
    replace: 'a$1.example',
  });
  const back = updateRow(doc, 'a', { caseMode: 'preserve' }).rules[0];
  expect(back).toEqual({
    id: 'a',
    type: 'literal',
    match: 'contoso-health.com',
    replace: 'a$1.example',
  });
});

it('treats a real regex as regex, and keeps its flags', () => {
  const doc: ProfileDoc = {
    ...base(),
    rules: [{ id: 'r', type: 'regex', match: 'CH-(\\d+)', replace: 'CLM-$1', flags: 'i' }],
  };
  expect(rowOf(doc, first(doc))).toMatchObject({ kind: 'regex', caseMode: 'reversible' });
  expect(updateRow(doc, 'r', { find: 'X(\\d)' }).rules[0]).toMatchObject({ flags: 'i' });
  expect(updateRow(doc, 'r', { flags: '' }).rules[0]).not.toHaveProperty('flags');
});

it('keeps fields the form does not show when editing a row', () => {
  const doc: ProfileDoc = {
    ...base(),
    rules: [
      {
        id: 'a',
        type: 'literal',
        match: 'Contoso',
        replace: 'Northwind',
        boundary: 'word',
        enabled: false,
        styles: ['lower'],
      },
    ],
  };
  expect(rowOf(doc, first(doc)).caseMode).toBe('custom');
  expect(updateRow(doc, 'a', { replace: 'Fabrikam' }).rules[0]).toEqual({
    id: 'a',
    type: 'literal',
    match: 'Contoso',
    replace: 'Fabrikam',
    boundary: 'word',
    enabled: false,
    styles: ['lower'],
  });
});

it('toggles an exclusion preset without touching other patterns', () => {
  const preset = exclusionPresets[0] as ExclusionPreset;
  const doc = { ...base(), exclude: ['deploy/'] };
  const on = togglePreset(doc, preset, true);
  expect(presetActive(on, preset)).toBe(true);
  expect(on.exclude).toContain('deploy/');
  const off = togglePreset(on, preset, false);
  expect(presetActive(off, preset)).toBe(false);
  expect(off.exclude).toEqual(['deploy/']);
  expect(togglePreset(base(), preset, false)).not.toHaveProperty('exclude');
});

it('only draws documents the form can represent', () => {
  expect(asProfileDoc(base())).toBeDefined();
  expect(asProfileDoc([])).toBeUndefined();
  expect(asProfileDoc({ rules: 'x' })).toBeUndefined();
  expect(asProfileDoc({ rules: [{ id: 'a', type: 'other' }] })).toBeUndefined();
  expect(asProfileDoc({ rules: [], exclude: [1] })).toBeUndefined();
});

it('finds the line of a JSON path, falling back to its parent', () => {
  const text = pretty({
    name: 'x',
    rules: [{ id: 'a', type: 'regex', match: 'a"b}', replace: '' }],
    exclude: ['z'],
  });
  const lineOf = (needle: string) =>
    text.split('\n').findIndex((line) => line.includes(needle)) + 1;
  expect(lineOfPath(text, 'name')).toBe(lineOf('"name"'));
  expect(lineOfPath(text, 'rules.0.replace')).toBe(lineOf('"replace"'));
  expect(lineOfPath(text, 'exclude.0')).toBe(lineOf('"z"'));
  expect(lineOfPath(text, 'rules.0.flags')).toBe(lineOf('"id"') - 1);
  expect(lineOfPath(text, '')).toBe(1);
  expect(lineOfPath('{broken', 'name')).toBeUndefined();
});

it('reports where the JSON stops parsing', () => {
  expect(parseProblem('{"a":1}')).toBeUndefined();
  expect(parseProblem('{\n"a":\n}')?.line).toBe(3);
});

it('counts added and removed lines against the saved text', () => {
  const { added, removed } = lineChanges('a\nb\nc', 'a\nx\nc\ny');
  expect([...added]).toEqual([2, 4]);
  expect(removed).toBe(1);
});

it('moves and duplicates the selected lines', () => {
  expect(moveLines('a\nb\nc', 2, 2, -1)).toEqual({ text: 'b\na\nc', start: 0, end: 0 });
  expect(moveLines('a\nb\nc', 2, 2, 1)).toEqual({ text: 'a\nc\nb', start: 4, end: 4 });
  expect(moveLines('a\nb', 0, 0, -1).text).toBe('a\nb');
  expect(moveLines('a\nb', 2, 2, 1).text).toBe('a\nb');
  expect(duplicateLines('a\nb', 0, 1)).toEqual({ text: 'a\na\nb', start: 2, end: 3 });
});

it('outlines a document', () => {
  const doc = addRule({ ...base(), exclude: ['x/'], include: ['y'] }, 'regex');
  expect(outlineOf(doc, 2)).toEqual({
    rules: 2,
    byKind: [
      { label: 'brand', count: 1 },
      { label: 'regex', count: 1 },
    ],
    exclude: 1,
    inherited: 2,
    include: 1,
  });
});

const incoming = (): ProfileDoc => ({
  ...base(),
  name: 'renamed',
  rules: [
    { id: 'a', type: 'literal', match: 'Contoso', replace: 'Tailspin' },
    { id: 'n', type: 'literal', match: 'Fabrikam', replace: 'Adventure' },
  ],
  exclude: ['new/'],
  extensions: { ruleKinds: { n: 'term' } },
});
const current = (): ProfileDoc => ({
  ...base(),
  rules: [...base().rules, { id: 'old', type: 'secret', detector: 'jwt' }],
  exclude: ['old/'],
});

it('diffs a pasted profile into one acceptable change per difference', () => {
  const changes = diffProfiles(current(), incoming());
  expect(changes.map((change) => [change.id, change.kind])).toEqual([
    ['field:name', 'changed'],
    ['rule:a', 'changed'],
    ['rule:n', 'added'],
    ['rule:old', 'removed'],
    ['exclude:new/', 'added'],
    ['exclude:old/', 'removed'],
  ]);
  expect(diffProfiles(current(), current())).toEqual([]);
});

it('applies only the accepted changes', () => {
  const none = applyChanges(current(), incoming(), new Set());
  expect(none).toEqual(current());
  const some = applyChanges(current(), incoming(), new Set(['rule:n', 'exclude:new/']));
  expect(some.name).toBe('names');
  expect(some.rules.map((rule) => rule.id)).toEqual(['a', 'old', 'n']);
  expect(some.rules[0]).toMatchObject({ replace: 'Northwind' });
  expect(some.exclude).toEqual(['old/', 'new/']);
  expect(some.extensions).toEqual({ ruleKinds: { n: 'term' } });
  const all = applyChanges(
    current(),
    incoming(),
    new Set(diffProfiles(current(), incoming()).map((change) => change.id)),
  );
  expect(all.name).toBe('renamed');
  expect(all.rules.map((rule) => rule.id)).toEqual(['a', 'n']);
  expect(all.exclude).toEqual(['new/']);
});
