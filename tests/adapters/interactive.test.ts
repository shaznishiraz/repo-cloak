import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createInteractiveIO } from '../../src/adapters/interactive.js';
import { validateProfile } from '../../src/core/rules.js';
import type { SavedProfile } from '../../src/core/profiles.js';

const prompts = vi.hoisted(() => ({ checkbox: vi.fn(), input: vi.fn(), select: vi.fn() }));
vi.mock('@inquirer/prompts', () => ({ ...prompts, editor: vi.fn(), confirm: vi.fn() }));

it('validates combined profiles live and offers creation without requiring a saved profile', async () => {
  const io = createInteractiveIO(
    () => {},
    async () => {},
  );
  const profile: SavedProfile = {
    id: 'pf_a',
    scope: { kind: 'global' },
    profile: validateProfile({
      kind: 'profile',
      schemaVersion: 1,
      name: 'first',
      rules: [{ id: 'a', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    }),
  };
  const other: SavedProfile = {
    ...profile,
    id: 'pf_b',
    profile: {
      ...profile.profile,
      name: 'second',
      rules: [{ id: 'b', type: 'literal', match: 'Acme', replace: 'Contoso' }],
    },
  };
  prompts.checkbox.mockImplementationOnce(
    async (config: {
      validate(choices: { value: SavedProfile | null }[]): string | boolean;
      choices: { value: SavedProfile | null; checked?: boolean }[];
    }) => {
      expect(config.validate([])).toMatch(/Choose at least/);
      expect(config.validate([{ value: null }])).toBe(true);
      expect(config.validate([{ value: profile }])).toBe(true);
      expect(config.validate([{ value: profile }, { value: other }])).toMatch(
        /first.*second|second.*first/,
      );
      expect(config.choices[0]?.value).toBe(other);
      expect(config.choices[0]?.checked).toBe(true);
      return [other, null];
    },
  );
  expect(await io.profiles([profile, other], [other.id])).toEqual({
    selected: [other],
    create: true,
  });
});

it('combines file, commit, working and extra selections and preserves tracked-file refresh', async () => {
  const io = createInteractiveIO(
    () => {},
    async () => {},
  );
  io.services.files = {
    ...io.services.files,
    expandPaths: async () => ['src/a.ts'],
    filterPaths: (paths) => paths,
  };
  io.services.git = {
    ...io.services.git,
    recentCommits: async () => [{ id: 'abc12345', subject: 'change' }],
  };
  prompts.checkbox
    .mockResolvedValueOnce(['tracked', 'files', 'commits', 'working', 'extra'])
    .mockResolvedValueOnce(['src/a.ts'])
    .mockResolvedValueOnce(['abc12345']);
  prompts.input.mockResolvedValueOnce('folder with spaces').mockResolvedValueOnce('');
  expect(
    await io.selection(
      { repoId: '0123456789abcdef', path: '/source', branch: 'main', commit: null },
      [],
      ['deleted.ts'],
    ),
  ).toEqual({
    includeTracked: true,
    files: ['src/a.ts', 'folder with spaces'],
    commits: ['abc12345'],
    working: true,
  });
});

it('accepts typed commit IDs, rejects unknown ones and removes duplicates', async () => {
  const io = createInteractiveIO(
    () => {},
    async () => {},
  );
  const first = 'a'.repeat(40);
  const second = 'b'.repeat(40);
  const known: Record<string, string> = { abc1234: first, main: first, 'v1.0': second };
  io.services.git = {
    ...io.services.git,
    recentCommits: async () => [{ id: first, subject: 'change' }],
    resolveCommit: async (_root, ref) => {
      const sha = known[ref];
      if (!sha) throw new Error('unknown revision');
      return sha;
    },
  };
  prompts.checkbox.mockResolvedValueOnce(['commits', 'commit-ids']).mockResolvedValueOnce([first]);
  const checks: (string | boolean)[] = [];
  for (const answer of ['abc1234', 'main', 'v1.0', '']) {
    prompts.input.mockImplementationOnce(
      async (config: { validate(value: string): Promise<string | boolean> }) => {
        checks.push(await config.validate('nope'), await config.validate(''));
        return answer;
      },
    );
  }
  expect(
    await io.selection(
      { repoId: '0123456789abcdef', path: '/source', branch: 'main', commit: first },
      [],
      [],
    ),
  ).toEqual({ commits: [first, second] });
  expect(checks[0]).toBe('Not a commit in this repository: nope');
  expect(checks[1]).toBe('Enter at least one commit');
  expect(checks.at(-1)).toBe(true);
});

it('offers the dashboard in the workspace menu', async () => {
  prompts.select.mockImplementationOnce(
    async (config: { choices: { name: string; value: string; disabled?: string }[] }) => {
      expect(
        config.choices.find((choice) => choice.name === 'Open web dashboard')?.disabled,
      ).toBeUndefined();
      expect(config.choices.map((choice) => choice.value)).toEqual([
        'extract',
        'restore',
        'status',
        'ui',
        'exit',
      ]);
      return 'exit';
    },
  );
  expect(
    await createInteractiveIO(
      () => {},
      async () => {},
    ).action('workspace', false),
  ).toBe('exit');
});

it('offers the current and known repositories, and validates a typed path', async () => {
  const io = createInteractiveIO(
    () => {},
    async () => {},
  );
  io.services.cwd = '/work';
  io.services.git = {
    ...io.services.git,
    findRepo: async (path) =>
      path === '/work/other' || path === join(homedir(), 'repo')
        ? { topLevel: path, commonDir: `${path}/.git`, repoId: '0123456789abcdef' }
        : undefined,
  };
  const current = { repoId: '0123456789abcdef', path: '/work/here', branch: 'main', commit: null };
  prompts.select.mockImplementationOnce(
    async (config: { default: unknown; choices: { value: unknown }[] }) => {
      expect(config.default).toBe('/work/here');
      expect(config.choices.map((choice) => choice.value)).toEqual([
        '/work/here',
        '/work/known',
        null,
      ]);
      return '/work/known';
    },
  );
  expect(await io.source(current, ['/work/here', '/work/known'])).toBe('/work/known');

  const checks: (string | boolean)[] = [];
  prompts.select.mockResolvedValueOnce(null);
  prompts.input.mockImplementationOnce(
    async (config: { validate(value: string): Promise<string | boolean> }) => {
      checks.push(
        await config.validate(' '),
        await config.validate('missing'),
        await config.validate('other'),
      );
      return 'other';
    },
  );
  expect(await io.source(current, [])).toBe('/work/other');
  expect(checks).toEqual(['Enter a path', 'Not a Git repository: /work/missing', true]);

  // Nothing to pick from: go straight to typing, with ~ meaning the home folder.
  prompts.select.mockClear();
  prompts.input.mockResolvedValueOnce('~/repo');
  expect(await io.source(undefined, [])).toBe(join(homedir(), 'repo'));
  expect(prompts.select).not.toHaveBeenCalled();
});

it('lists worktrees that exist, marks the main one and defaults to the current one', async () => {
  const io = createInteractiveIO(
    () => {},
    async () => {},
  );
  const main = await mkdtemp(join(tmpdir(), 'cloak main '));
  const feature = await mkdtemp(join(tmpdir(), 'cloak feature '));
  try {
    const mainTree = { path: main, branch: 'main' };
    const removed = { path: join(main, 'removed'), branch: 'gone' };
    const trees = [mainTree, { path: feature, branch: 'feature' }, removed];
    prompts.select.mockImplementationOnce(
      async (config: { default: unknown; choices: { name: string; value: unknown }[] }) => {
        expect(config.default).toBe(feature);
        expect(config.choices.map((choice) => choice.value)).toEqual([main, feature]);
        expect(config.choices[0]?.name).toContain('(main worktree)');
        return feature;
      },
    );
    expect(await io.worktree(trees, feature)).toBe(feature);
    prompts.select.mockImplementationOnce(async (config: { default: unknown }) => {
      expect(config.default).toBe(main);
      return main;
    });
    expect(await io.worktree(trees, undefined)).toBe(main);
    prompts.select.mockClear();
    expect(await io.worktree([mainTree, removed], undefined)).toBe(main);
    expect(prompts.select).not.toHaveBeenCalled();
  } finally {
    await Promise.all(
      [main, feature].map((path) =>
        rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      ),
    );
  }
});
