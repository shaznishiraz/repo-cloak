import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDesktop } from '../../src/adapters/desktop.js';
import { runGit } from '../../src/adapters/git.js';
import { createStore } from '../../src/adapters/store.js';
import { createDashboard } from '../../src/application/dashboard.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(desktop?: ReturnType<typeof createDesktop>) {
  const root = await mkdtemp(join(tmpdir(), 'cloak dashboard '));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = createStore(join(root, 'store'));
  const dashboard = createDashboard(store, root, desktop);
  cleanups.push(async () => dashboard.sync.close());
  await store.writePlain('config.json', 'config', {
    kind: 'config',
    schemaVersion: 1,
    initGit: false,
  });
  return { root, store, dashboard };
}
async function repository(path: string, file: string, text: string) {
  await mkdir(path);
  await runGit(path, ['init', '-b', 'main']);
  await writeFile(join(path, file), text);
}
const emptyProfile = (name: string) => ({ kind: 'profile', schemaVersion: 1, name, rules: [] });
async function cloak(
  dashboard: ReturnType<typeof createDashboard>,
  source: string,
  destination: string,
  file: string,
) {
  const { repoId, worktree } = await dashboard.addRepository({ path: source });
  const profile = await dashboard.saveProfile({
    scope: { kind: 'repo', repoId },
    profile: emptyProfile('names'),
  });
  const preview = await dashboard.sync.preview({
    intent: 'create',
    repoId,
    worktree,
    destination,
    files: [file],
    profiles: [{ id: profile.id, scope: profile.scope }],
  });
  await dashboard.sync.apply(preview.operationId, {});
  const state = await dashboard.sync.wait(preview.operationId);
  if (!state.result) throw new Error(state.error ?? 'Missing fixture workspace');
  return { repoId, worktree, workspaceId: state.result.workspaceId, path: state.result.workspace };
}

it('removes and re-adds a repository without touching source files', async () => {
  const { root, dashboard } = await fixture();
  const source = join(root, 'source');
  await repository(source, 'keep.txt', 'keep source');
  const { repoId } = await dashboard.addRepository({ path: source });
  await expect(dashboard.removeRepository('not-a-repo')).rejects.toThrow();
  await expect(dashboard.removeRepository('a'.repeat(16))).rejects.toMatchObject({
    code: 'unknown',
  });
  await dashboard.removeRepository(repoId);
  expect(await dashboard.overview()).toEqual([]);
  expect(await readFile(join(source, 'keep.txt'), 'utf8')).toBe('keep source');
  await dashboard.addRepository({ path: source });
  expect(await dashboard.overview()).toMatchObject([{ id: repoId }]);
});

it('registers only Git sources, never the store or a cloak workspace', async () => {
  const { root, store, dashboard } = await fixture();
  const source = join(root, 'added source');
  await repository(source, 'a.txt', 'a');
  const context = await dashboard.addRepository({ path: source });
  expect(context.repoId).toMatch(/^[a-f0-9]{16}$/);
  await expect(dashboard.addRepository({ path: store.root })).rejects.toThrow();
  const workspace = join(root, 'cloak');
  await mkdir(join(workspace, '.repo-cloak'), { recursive: true });
  await writeFile(join(workspace, '.repo-cloak', 'manifest.json'), '{}');
  await expect(dashboard.addRepository({ path: workspace })).rejects.toThrow();
});

it('opens only registered folders, with allowlisted targets and no caller-supplied path', async () => {
  const opened: string[] = [];
  const desktop = createDesktop(
    'darwin',
    async (_command, args) => {
      opened.push((args[0] === 'repo' ? args[3] : args.at(-1)) ?? '');
    },
    async (name) => `/Applications/${name}`,
    'orca',
  );
  const { root, dashboard } = await fixture(desktop);
  const source = join(root, 'source');
  await repository(source, 'file.ts', 'export const safe = true;');
  const made = await cloak(dashboard, source, join(root, 'cloak'), 'file.ts');
  const group = await dashboard.groups.save({
    name: 'App',
    members: [{ repoId: made.repoId, workspaceId: made.workspaceId, worktree: source }],
    moveWorkspaces: true,
  });
  await expect(dashboard.desktop.openGroup(group.id, { target: 'sh' })).rejects.toThrow();
  await expect(
    dashboard.desktop.openGroup(group.id, { target: 'vscode', path: source }),
  ).rejects.toThrow();
  await expect(
    dashboard.desktop.openWorkspace(made.repoId, made.workspaceId, {
      target: 'orca',
      path: source,
    }),
  ).rejects.toThrow();
  expect(opened).toEqual([]);
  await dashboard.desktop.openGroup(group.id, { target: 'vscode' });
  await dashboard.desktop.openWorkspace(made.repoId, made.workspaceId, { target: 'folder' });
  const moved = await dashboard.sync.workspaceTarget(made.repoId, made.workspaceId);
  await dashboard.desktop.openGroup(group.id, { target: 'orca' });
  await dashboard.desktop.openWorkspace(made.repoId, made.workspaceId, { target: 'orca' });
  expect(opened).toEqual([group.folder, moved.path, group.folder, moved.path]);
});

it('runs a guarded group sync and enforces revisions on edit and delete', async () => {
  const { root, dashboard } = await fixture();
  const source = join(root, 'Backend');
  const destination = join(root, 'backend-cloak');
  await repository(source, 'backend.ts', 'export const backend = true;');
  const made = await cloak(dashboard, source, destination, 'backend.ts');
  const input = {
    name: 'Product',
    members: [{ repoId: made.repoId, workspaceId: made.workspaceId, worktree: made.worktree }],
  };
  await expect(dashboard.groups.save({ name: 'Invalid', members: [] })).rejects.toThrow();
  const saved = await dashboard.groups.save(input);
  expect(await dashboard.groups.list()).toMatchObject([{ id: saved.id, name: 'Product' }]);
  const batch = await dashboard.groups.preview(saved.id, {
    revision: saved.revision,
    intent: 'refresh',
  });
  await expect(
    dashboard.sync.apply(batch.operationId, { deletions: true, profiles: true }),
  ).rejects.toThrow();
  await dashboard.groups.apply(batch.operationId, { members: [] });
  await dashboard.groups.wait(batch.operationId);
  expect(dashboard.groups.status(batch.operationId)).toMatchObject({
    state: 'completed',
    members: [{ state: 'completed' }],
  });
  await expect(dashboard.groups.retry(batch.operationId)).rejects.toThrow();
  dashboard.groups.cancel(batch.operationId);
  const edited = await dashboard.groups.save(
    { ...input, name: 'Renamed' },
    saved.id,
    saved.revision,
  );
  await expect(dashboard.groups.remove(saved.id, saved.revision)).rejects.toMatchObject({
    code: 'stale',
  });
  await dashboard.groups.remove(saved.id, edited.revision);
  expect(await dashboard.groups.list()).toEqual([]);
  expect(await readFile(join(destination, 'backend.ts'), 'utf8')).toContain('backend');
});

it('validates, seals, edits, checks and deletes profiles', async () => {
  const { store, dashboard } = await fixture();
  const profile = {
    kind: 'profile',
    schemaVersion: 1,
    name: 'client',
    rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    extensions: { custom: true },
  };
  const scope = { kind: 'global' };
  await expect(
    dashboard.saveProfile({
      scope,
      profile: { ...profile, rules: [{ id: 'broken', type: 'regex', match: '[', replace: 'x' }] },
    }),
  ).rejects.toThrow('broken');
  expect(await dashboard.profiles()).toEqual([]);
  const saved = await dashboard.saveProfile({ scope, profile });
  expect(saved.id).toMatch(/^pf_/);
  const disk = await readFile(join(store.root, 'profiles', `${saved.id}.json`), 'utf8');
  expect(disk).not.toContain('Acme');
  await dashboard.saveProfile({ id: saved.id, scope, profile: { ...profile, description: 'x' } });
  const reference = { scope, id: saved.id };
  expect(await dashboard.checkProfiles([reference])).toEqual({ profiles: 1, rules: 1 });
  await expect(dashboard.checkProfiles([reference, reference])).rejects.toThrow();
  expect(dashboard.validateProfile(emptyProfile('imported'))).toEqual(emptyProfile('imported'));
  expect(() =>
    dashboard.validateProfile({
      ...emptyProfile('imported'),
      rules: [{ type: 'regex', id: 'bad', match: '(', replace: '' }],
    }),
  ).toThrow();
  await dashboard.deleteProfile(reference);
  expect(await dashboard.profiles()).toEqual([]);
});

it('expires cancelled previews and deletes a workspace only with its confirmed path', async () => {
  const { root, dashboard } = await fixture();
  const source = join(root, 'source');
  const destination = join(root, 'workspace');
  await repository(source, 'file.txt', 'kept');
  const made = await cloak(dashboard, source, destination, 'file.txt');
  await expect(dashboard.sync.apply('unknown', {})).rejects.toMatchObject({ code: 'unknown' });
  const cancelled = await dashboard.sync.preview({
    intent: 'refresh',
    repoId: made.repoId,
    workspaceId: made.workspaceId,
    worktree: source,
  });
  dashboard.sync.cancel(cancelled.operationId);
  await expect(dashboard.sync.apply(cancelled.operationId, {})).rejects.toMatchObject({
    code: 'expired',
  });
  await expect(
    dashboard.deleteWorkspace(made.repoId, made.workspaceId, { path: destination }),
  ).rejects.toThrow();
  expect(await readFile(join(destination, 'file.txt'), 'utf8')).toBe('kept');
  await dashboard.deleteWorkspace(made.repoId, made.workspaceId, {
    path: made.path,
    confirm: true,
  });
  await expect(dashboard.workspace(made.repoId, made.workspaceId)).rejects.toThrow();
});

it('searches nested paths while keeping directory browsing scoped', async () => {
  const { root, dashboard } = await fixture();
  const source = join(root, 'search-source');
  await repository(source, 'root.txt', 'root');
  await mkdir(join(source, 'src'));
  await writeFile(join(source, 'src', 'Example.ts'), 'example');
  const { repoId } = await dashboard.addRepository({ path: source });
  expect(await dashboard.sync.selection(repoId, source, 0, 'EXAMPLE', [])).toMatchObject({
    files: ['src/Example.ts'],
    working: ['root.txt', 'src/Example.ts'],
    workingCount: 2,
  });
  expect(await dashboard.sync.selection(repoId, source, 0, 'EXAMPLE', [], '')).toMatchObject({
    files: [],
    directories: ['src'],
  });
});

it('honours ignore preferences and returns only fresh path metadata', async () => {
  const { root, dashboard } = await fixture();
  const source = join(root, 'inventory-source');
  await repository(source, '.gitignore', '.env\n');
  await writeFile(join(source, '.env'), 'synthetic private content');
  const { repoId } = await dashboard.addRepository({ path: source });
  expect(await dashboard.sync.inventory(repoId, source, [], true)).toEqual({
    files: ['.gitignore'],
  });
  const shown = await dashboard.sync.inventory(repoId, source, [], false);
  expect(shown).toEqual({ files: ['.env', '.gitignore'] });
  expect(JSON.stringify(shown)).not.toContain('synthetic private content');
  await writeFile(join(source, 'fresh.ts'), 'fresh');
  expect(await dashboard.sync.inventory(repoId, source, [], true)).toEqual({
    files: ['.gitignore', 'fresh.ts'],
  });
});

it('pages commits and resolves refs, rejecting invalid input', async () => {
  const { root, dashboard } = await fixture();
  const source = join(root, 'source');
  await repository(source, 'a.txt', 'a');
  for (const subject of ['first', 'second'])
    await runGit(source, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      subject,
    ]);
  const { repoId, worktree } = await dashboard.addRepository({ path: source });
  const recent = await dashboard.sync.commits(repoId, worktree);
  expect(recent.map((commit) => commit.subject)).toEqual(['second', 'first']);
  const older = await dashboard.sync.commits(repoId, worktree, 1);
  expect(older.map((commit) => commit.subject)).toEqual(['first']);
  expect((await dashboard.sync.commits(repoId, worktree, 0, 'HEAD~1'))[0]?.id).toBe(recent[1]?.id);
  await expect(dashboard.sync.commits(repoId, worktree, -1)).rejects.toThrow();
  await expect(dashboard.sync.commits(repoId, worktree, 0, 'missing')).rejects.toThrow();
});
