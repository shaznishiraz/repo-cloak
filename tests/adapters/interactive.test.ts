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
