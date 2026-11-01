import { expect, it } from 'vitest';
import type { Overview, TreeNode } from '../../src/web/api/contracts.js';
import {
  compactCount,
  joinFolder,
  launchTarget,
  nameProblem,
  parentFolder,
  pickState,
  relativeTime,
  togglePick,
} from '../../src/web/screens/new/model.js';

const file = (path: string, excludedBy: string | null = null): TreeNode => ({
  path,
  kind: 'file',
  files: excludedBy ? 0 : 1,
  excludedBy,
});
const folder = (path: string): TreeNode => ({ path, kind: 'folder', files: 2, excludedBy: null });
const levels: Record<string, TreeNode[]> = {
  src: [folder('src/a'), file('src/top.ts'), file('src/Secret.cs', 'rule')],
  'src/a': [file('src/a/one.ts'), file('src/a/two.ts')],
};
const childrenOf = (path: string) => levels[path];

it('reports on, partial and off through ancestors and descendants', () => {
  const picked = new Set(['src/a']);
  expect(pickState('src/a', picked)).toBe('on');
  expect(pickState('src/a/one.ts', picked)).toBe('on');
  expect(pickState('src', picked)).toBe('partial');
  expect(pickState('src/ab', picked)).toBe('off');
});

it('picks a folder in place of anything picked inside it', () => {
  const next = togglePick(new Set(['src/a/one.ts', 'other.ts']), folder('src'), childrenOf);
  expect([...next].sort()).toEqual(['other.ts', 'src']);
});

it('unpicking a file in a picked folder keeps its siblings but never an excluded one', () => {
  const next = togglePick(new Set(['src']), file('src/a/one.ts'), childrenOf);
  expect([...next].sort()).toEqual(['src/a/two.ts', 'src/top.ts']);
});

it('unpicks a picked node directly and leaves the rest alone', () => {
  expect([...togglePick(new Set(['a.ts', 'b.ts']), file('a.ts'), childrenOf)]).toEqual(['b.ts']);
});

it('keeps the selection when a level it would expand is not loaded', () => {
  const next = togglePick(new Set(['src']), file('src/a/one.ts'), () => undefined);
  expect([...next]).toEqual(['src']);
});

it('starts from the launch context, or the only repository, and otherwise asks', () => {
  const base = {
    repos: [
      { id: 'a', name: 'a', path: '/a', missing: false, workspaceCount: 0 },
      { id: 'b', name: 'b', path: '/b', missing: false, workspaceCount: 0 },
    ],
    workspaces: [],
  } as unknown as Overview;
  expect(launchTarget(null)).toBeNull();
  expect(launchTarget({ ...base, launch: { kind: 'none' } })).toBeNull();
  expect(
    launchTarget({
      ...base,
      launch: { kind: 'repo', repoId: 'a', label: 'a', path: '/a/tree', branch: null },
    }),
  ).toEqual({ repoId: 'a', worktree: '/a/tree' });
  expect(
    launchTarget({ ...base, repos: base.repos.slice(0, 1), launch: { kind: 'none' } }),
  ).toEqual({ repoId: 'a', worktree: '/a' });
});

it('formats times, counts, paths and names', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  expect(relativeTime('2026-01-10T10:00:00Z', now)).toBe('2h ago');
  expect(relativeTime('2026-01-09T10:00:00Z', now)).toBe('yesterday');
  expect(relativeTime('2026-01-06T10:00:00Z', now)).toBe('4d ago');
  expect(relativeTime('nonsense', now)).toBe('');
  expect(compactCount(950)).toBe('950');
  expect(compactCount(2900)).toBe('2.9k');
  expect(compactCount(12_400)).toBe('12k');
  expect(joinFolder('/c/', 'x')).toBe('/c/x');
  expect(joinFolder('C:\\c', 'x')).toBe('C:\\c\\x');
  expect(parentFolder('/a/b/')).toBe('/a');
  expect(parentFolder('/a')).toBe('/');
  expect(nameProblem('')).toBeTruthy();
  expect(nameProblem('a/b')).toBeTruthy();
  expect(nameProblem('..')).toBeTruthy();
  expect(nameProblem('x'.repeat(81))).toBeTruthy();
  expect(nameProblem('acme-care')).toBeUndefined();
});
