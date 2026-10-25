import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { runGit } from '../../src/adapters/git.js';
import { createTestSync } from '../support/sync.js';
import { validateProfile } from '../../src/core/rules.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak history ')));
  roots.push(root);
  const source = join(root, 'source');
  const workspace = join(root, 'cloak');
  await mkdir(source);
  await runGit(source, ['init', '-b', 'main']);
  await runGit(source, [
    '-c',
    'core.hooksPath=',
    '-c',
    'commit.gpgSign=false',
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'Source baseline',
  ]);
  await writeFile(join(source, 'file.txt'), 'before');
  const store = createStore(join(root, 'store'));
  const services = createSyncServices(source, store);
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  await services.profiles.save(
    { kind: 'global' },
    validateProfile({
      kind: 'profile',
      schemaVersion: 1,
      name: 'history',
      include: ['file.txt'],
      exclude: ['notes.md'],
      rules: [],
    }),
  );
  await createTestSync(services, '2.0.0')('push', {
    files: ['file.txt'],
    profiles: ['history'],
    to: workspace,
  });
  const cloak = createSyncServices(workspace, store);
  return { source, workspace, cloak, sync: createTestSync(cloak, '2.0.0') };
}

it('always creates cloak Git and checkpoints Pull and Push without committing source or credentials', async () => {
  const { source, workspace, cloak, sync } = await fixture();
  const initial = (await runGit(workspace, ['rev-parse', 'HEAD'])).trim();
  const sourceHead = await runGit(source, ['rev-parse', 'HEAD']);
  expect((await runGit(workspace, ['branch', '--show-current'])).trim()).toBe('cloak');
  await writeFile(join(source, 'file.txt'), 'pulled');
  await sync('pull', {});
  const pulled = (await runGit(workspace, ['rev-parse', 'HEAD'])).trim();
  expect(pulled).not.toBe(initial);
  expect((await runGit(workspace, ['rev-parse', 'HEAD^'])).trim()).toBe(initial);
  await writeFile(join(workspace, 'file.txt'), 'agent edit');
  await sync('push', {});
  expect((await runGit(workspace, ['rev-parse', 'HEAD^'])).trim()).toBe(pulled);
  expect((await runGit(workspace, ['log', '-1', '--format=%s'])).trim()).toBe(
    'Push changes to source',
  );
  expect(await runGit(workspace, ['show', 'HEAD:file.txt'])).toBe('agent edit');
  expect(await runGit(workspace, ['show', 'HEAD:.repo-cloak/manifest.json'])).toBe(
    await readFile(join(workspace, '.repo-cloak/manifest.json'), 'utf8'),
  );
  expect(await readFile(join(source, 'file.txt'), 'utf8')).toBe('agent edit');
  expect(await runGit(source, ['rev-parse', 'HEAD'])).toBe(sourceHead);
  const tracked = await runGit(workspace, ['ls-files']);
  expect(tracked).toContain('.repo-cloak/manifest.json');
  expect(tracked).not.toMatch(/token|connection.json|SKILL.md|AGENTS.md|CLAUDE.md|\.codex/);
  await sync('push', {});
  expect((await runGit(workspace, ['rev-list', '--count', 'HEAD'])).trim()).toBe('4');
  await runGit(workspace, [
    'restore',
    `--source=${pulled}`,
    '--worktree',
    '--',
    'file.txt',
    '.repo-cloak/manifest.json',
  ]);
  expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('pulled');
  expect((await cloak.store.readSnapshot(workspace))?.data.files['file.txt']).toBeDefined();
});

it('preserves unrelated staged work and refuses overlapping staged Push changes', async () => {
  const { source, workspace, sync } = await fixture();
  await writeFile(join(workspace, 'notes.md'), 'private local notes');
  await runGit(workspace, ['add', '--', 'notes.md']);
  await writeFile(join(workspace, 'file.txt'), 'agent edit');
  await sync('push', {});
  expect((await runGit(workspace, ['diff', '--cached', '--name-only'])).trim()).toBe('notes.md');
  expect(await runGit(workspace, ['ls-tree', '--name-only', 'HEAD'])).not.toContain('notes.md');
  await writeFile(join(workspace, 'file.txt'), 'staged edit');
  await runGit(workspace, ['add', '--', 'file.txt']);
  const head = await runGit(workspace, ['rev-parse', 'HEAD']);
  await expect(sync('push', {})).rejects.toThrow(/Unstage/);
  expect(await runGit(workspace, ['rev-parse', 'HEAD'])).toBe(head);
  expect(await readFile(join(source, 'file.txt'), 'utf8')).toBe('agent edit');
});

it('rolls source files, manifest and Git index back if the Push checkpoint fails', async () => {
  const { source, workspace, sync } = await fixture();
  await writeFile(join(workspace, 'file.txt'), 'agent edit');
  await writeFile(join(workspace, 'notes.md'), 'staged notes');
  await runGit(workspace, ['add', '--', 'notes.md']);
  const manifest = await readFile(join(workspace, '.repo-cloak/manifest.json'));
  const index = await readFile(join(workspace, '.git/index'));
  const head = await runGit(workspace, ['rev-parse', 'HEAD']);
  await writeFile(join(workspace, '.git/index.lock'), 'busy');
  await expect(sync('push', {})).rejects.toThrow(/index.lock/);
  expect(await readFile(join(source, 'file.txt'), 'utf8')).toBe('before');
  expect(await readFile(join(workspace, 'file.txt'), 'utf8')).toBe('agent edit');
  expect(await readFile(join(workspace, '.repo-cloak/manifest.json'))).toEqual(manifest);
  expect(await readFile(join(workspace, '.git/index'))).toEqual(index);
  expect(await runGit(workspace, ['rev-parse', 'HEAD'])).toBe(head);
});

it('initializes legacy cloaks on the next Pull and records their existing managed files', async () => {
  const { workspace, sync } = await fixture();
  await rm(join(workspace, '.git'), { recursive: true });
  await sync('pull', {});
  expect(await runGit(workspace, ['show', 'HEAD:file.txt'])).toBe('before');
  expect((await runGit(workspace, ['status', '--porcelain'])).trim()).toBe('');
});
