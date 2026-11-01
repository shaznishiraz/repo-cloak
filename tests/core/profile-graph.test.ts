import { describe, expect, it } from 'vitest';
import { mergeProfiles } from '../../src/core/merge.js';
import {
  assertWithinRoots,
  expandProfiles,
  extendsDirectly,
  isAllowedPath,
  rootProblem,
} from '../../src/core/profile-graph.js';
import type { ProfileScope, SavedProfile } from '../../src/core/profiles.js';
import type { Profile } from '../../src/core/rules.js';

const global: ProfileScope = { kind: 'global' };
const repoA: ProfileScope = { kind: 'repo', repoId: 'a'.repeat(16) };
const repoB: ProfileScope = { kind: 'repo', repoId: 'b'.repeat(16) };
function saved(name: string, parents: string[] = [], scope = global): SavedProfile {
  return {
    id: `pf_${scope.kind === 'repo' ? scope.repoId[0] : 'g'}_${name}`,
    scope,
    profile: {
      kind: 'profile',
      schemaVersion: 2,
      name,
      rules: [{ id: 'r', type: 'literal', match: `Orig${name}`, replace: `Anon${name}` }],
      ...(parents.length ? { extends: parents } : {}),
    },
  };
}
const names = (list: SavedProfile[]) => list.map((item) => item.profile.name);

describe('expandProfiles', () => {
  it('returns parents first, each once, across a diamond', () => {
    const base = saved('base');
    const left = saved('left', ['base']);
    const right = saved('right', ['base']);
    const child = saved('child', ['left', 'right']);
    expect(names(expandProfiles([child], [base, left, right, child]))).toEqual([
      'base',
      'left',
      'right',
      'child',
    ]);
  });
  it('keeps a plain selection, in order, untouched', () => {
    const a = saved('a');
    const b = saved('b');
    expect(expandProfiles([b, a], [a, b])).toEqual([b, a]);
  });
  it('gives the same list when expanding an already expanded selection', () => {
    const base = saved('base');
    const child = saved('child', ['base']);
    const once = expandProfiles([child], [base, child]);
    expect(expandProfiles(once, [base, child])).toEqual(once);
  });
  it('accepts a parent selected alongside its child, in either order', () => {
    const base = saved('base');
    const child = saved('child', ['base']);
    expect(names(expandProfiles([child, base], [base, child]))).toEqual(['base', 'child']);
  });
  it('rejects a missing parent, naming child and reference', () => {
    const child = saved('child', ['nope']);
    expect(() => expandProfiles([child], [child])).toThrow(/child extends "nope".*not found/);
  });
  it('rejects cycles, including a profile extending itself', () => {
    const a = saved('a', ['b']);
    const b = saved('b', ['a']);
    expect(() => expandProfiles([a], [a, b])).toThrow('a -> b -> a');
    const self = saved('self', ['self']);
    expect(() => expandProfiles([self], [self])).toThrow(/extend each other/);
  });
  it('allows 8 levels and rejects a ninth', () => {
    const chain = (levels: number) =>
      Array.from({ length: levels }, (_, index) =>
        saved(`p${index}`, index + 1 < levels ? [`p${index + 1}`] : []),
      );
    const fine = chain(8);
    expect(expandProfiles([fine[0] as SavedProfile], fine)).toHaveLength(8);
    const deep = chain(9);
    expect(() => expandProfiles([deep[0] as SavedProfile], deep)).toThrow(/deeper than 8/);
  });
  it('rejects selecting one profile twice', () => {
    const a = saved('a');
    expect(() => expandProfiles([a, a], [a])).toThrow(/selected twice/);
  });
  it('lets a repo profile extend global and its own repository, never another', () => {
    const globalBase = saved('gbase');
    const own = saved('own', [], repoA);
    const other = saved('other', [], repoB);
    const child = saved('child', ['gbase', 'own'], repoA);
    expect(names(expandProfiles([child], [globalBase, own, other, child]))).toEqual([
      'gbase',
      'own',
      'child',
    ]);
    const reach = saved('reach', ['other'], repoA);
    expect(() => expandProfiles([reach], [other, reach])).toThrow(/not found/);
  });
  it('never lets a global profile extend a repo profile', () => {
    const own = saved('own', [], repoA);
    const child = saved('child', ['own']);
    expect(() => expandProfiles([child], [own, child])).toThrow(/not found/);
    const qualified = saved('child', ['repo:own']);
    expect(() => expandProfiles([qualified], [own, qualified])).toThrow(/not found/);
  });
  it('makes a name in both scopes an error until it is qualified', () => {
    const inGlobal = saved('base');
    const inRepo = saved('base', [], repoA);
    const child = saved('child', ['base'], repoA);
    expect(() => expandProfiles([child], [inGlobal, inRepo, child])).toThrow(/ambiguous/);
    const qualified = saved('child', ['global:base'], repoA);
    expect(expandProfiles([qualified], [inGlobal, inRepo, qualified])[0]).toBe(inGlobal);
    const own = saved('child', ['repo:base'], repoA);
    expect(expandProfiles([own], [inGlobal, inRepo, own])[0]).toBe(inRepo);
  });
});

describe('mergeProfiles with parents', () => {
  it('refuses a list missing a parent instead of dropping its rules', () => {
    expect(() => mergeProfiles([saved('child', ['base'])])).toThrow(/not found/);
  });
  it('merges parent and child rules', () => {
    const base = saved('base');
    const child = saved('child', ['base']);
    expect(mergeProfiles([base, child]).map((rule) => (rule as { match: string }).match)).toEqual([
      'Origbase',
      'Origchild',
    ]);
  });
  it('reports a child that contradicts a parent', () => {
    const base = saved('base');
    const child = saved('child', ['base']);
    child.profile.rules = [{ id: 'c', type: 'literal', match: 'Origbase', replace: 'Different' }];
    expect(() => mergeProfiles([base, child])).toThrow(/same original/);
  });
});

it('extendsDirectly honours scope and qualifiers', () => {
  const base = saved('base');
  const repoBase = saved('base', [], repoA);
  expect(extendsDirectly(saved('c', ['base']), base)).toBe(true);
  expect(extendsDirectly(saved('c', ['global:base']), base)).toBe(true);
  expect(extendsDirectly(saved('c', ['repo:base'], repoA), base)).toBe(false);
  expect(extendsDirectly(saved('c', ['base'], repoB), repoBase)).toBe(false);
  expect(extendsDirectly(saved('c'), base)).toBe(false);
  expect(extendsDirectly(base, base)).toBe(false);
});

const roots = (...allowRoots: string[]): Profile => ({
  kind: 'profile',
  schemaVersion: 2,
  name: 'r',
  rules: [],
  allowRoots,
});
const free: Profile = { kind: 'profile', schemaVersion: 2, name: 'f', rules: [] };

describe('allowRoots', () => {
  it('does not restrict profiles that declare no roots', () => {
    expect(isAllowedPath('anything/at/all.ts', [free])).toBe(true);
    expect(isAllowedPath('anything.ts', [])).toBe(true);
  });
  it('allows paths under a root, with or without the trailing slash', () => {
    for (const root of ['src/', 'src']) {
      expect(isAllowedPath('src/a.ts', [roots(root)])).toBe(true);
      expect(isAllowedPath('src/deep/a.ts', [roots(root)])).toBe(true);
    }
  });
  it.each([
    ['sibling with the same prefix', 'src-private/a.ts'],
    ['outside', 'docs/a.ts'],
    ['traversal out of the root', 'src/../secrets/a.ts'],
    ['dot segment', './src/a.ts'],
    ['absolute', '/src/a.ts'],
    ['other letter case', 'SRC/a.ts'],
    ['backslashes', 'src\\a.ts'],
    ['empty', ''],
    ['metadata inside a root', 'src/.git/config'],
  ])('fails closed for %s', (_name, path) => {
    expect(isAllowedPath(path, [roots('src/')])).toBe(false);
  });
  it('allows nothing for an empty list', () => {
    expect(isAllowedPath('src/a.ts', [roots()])).toBe(false);
  });
  it('needs every profile that declares roots to allow the path', () => {
    expect(isAllowedPath('src/a.ts', [roots('src/'), free])).toBe(true);
    expect(isAllowedPath('src/api/a.ts', [roots('src/'), roots('src/api/')])).toBe(true);
    expect(isAllowedPath('src/a.ts', [roots('src/'), roots('src/api/')])).toBe(false);
    expect(isAllowedPath('src/a.ts', [roots('src/'), roots('docs/')])).toBe(false);
  });
  it.each(['../x', '/src', '.', './', '*', 'src/*', '{a,b}', '.git/', 'a\\b', 'a/../b', '/'])(
    'refuses the root %s and it matches nothing even if stored',
    (root) => {
      expect(rootProblem(root)).toBeTruthy();
      for (const path of ['src/a.ts', 'a.ts', 'x'])
        expect(isAllowedPath(path, [roots(root)])).toBe(false);
    },
  );
  it('accepts nested folders as roots', () => {
    expect(rootProblem('src/')).toBeUndefined();
    expect(rootProblem('tests/api')).toBeUndefined();
  });
  it('checks where a symlink really leads', () => {
    const profile = { id: 'pf_r', scope: global, profile: roots('src/') };
    const bytes = new Uint8Array(1);
    expect(() =>
      assertWithinRoots([{ path: 'src/link', realPath: 'secrets/key', bytes }], [profile]),
    ).toThrow('secrets/key is outside the allowed roots');
    expect(() => assertWithinRoots([{ path: 'docs/a', bytes }], [profile])).toThrow(
      'docs/a is outside',
    );
    assertWithinRoots([{ path: 'src/a', bytes }], [profile]);
    // A deleted file has no contents to protect.
    assertWithinRoots([{ path: 'docs/gone' }], [profile]);
  });
});
