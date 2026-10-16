import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyncServices } from '../src/adapters/sync-services.js';
import { createStore } from '../src/adapters/store.js';
import { runGit } from '../src/adapters/git.js';
import { createSyncCommand } from '../src/commands/sync.js';
import { validateProfile } from '../src/core/rules.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(initGit = false) {
  const temporary = await mkdtemp(join(tmpdir(), 'cloak sync '));
  const root = await realpath(temporary);
  roots.push(root);
  const source = join(root, 'acme-source');
  const destination = join(root, 'workspace');
  const store = createStore(join(root, 'store'));
  await mkdir(source);
  await runGit(source, ['init', '-b', 'main']);
  await runGit(source, ['config', 'core.hooksPath', join(root, 'no-hooks')]);
  await runGit(source, ['config', 'commit.gpgSign', 'false']);
  await runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'initial',
  ]);
  await mkdir(join(source, 'src'));
  await writeFile(join(source, 'src', 'Acme.ts'), '\uFEFFexport class Acme {}\r\n');
  const services = createSyncServices(source, store);
  services.interactive = false;
  const profile = await services.profiles.save(
    { kind: 'global' },
    validateProfile({
      kind: 'profile',
      schemaVersion: 1,
      name: 'acme',
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    }),
  );
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit });
  const push = createSyncCommand(services, '2.0.0');
  const options = { profiles: ['acme'], files: ['src'], to: destination, yes: true };
  return { root, source, destination, store, services, profile, push, options };
}
describe('extraction commands with real adapters', () => {
  it('extracts anonymized text, seals originals, and records a workspace and backup', async () => {
    const { destination, source, store, services, push, options } = await fixture();
    const result = await push('push', options);
    expect(result.status).toBe('written');
    expect(await readFile(join(destination, 'src', 'Northwind.ts'), 'utf8')).toBe(
      '\uFEFFexport class Northwind {}\r\n',
    );
    const manifest = await readFile(join(destination, '.repo-cloak', 'manifest.json'), 'utf8');
    const publicPart = { ...JSON.parse(manifest), sealed: '[encrypted]' } as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(publicPart)).not.toMatch(/Acme|acme-source|feature\//);
    const snapshot = await services.store.readSnapshot(destination);
    expect(snapshot?.data.source.path).toBe(source);
    expect(snapshot?.data.files['src/Northwind.ts']?.path).toBe('src/Acme.ts');
    const record = snapshot
      ? await services.store.readRepo(snapshot.plain.source.repoId)
      : undefined;
    expect(record?.workspaces[result.workspaceId]?.path).toBe(destination);
    const backups = await readdir(
      join(store.root, 'repos', snapshot?.plain.source.repoId ?? '', 'manifests'),
    );
    expect(backups).toHaveLength(1);
  });
  it('does not create a destination, locks, or store files during dry-run', async () => {
    const { destination, store, push, options } = await fixture();
    const before = await readdir(store.root, { recursive: true });
    const keyChanged = (await stat(join(store.root, 'key'))).ctimeMs;
    const result = await push('push', { ...options, dryRun: true });
    expect(result.status).toBe('dry-run');
    await expect(readFile(join(destination, '.repo-cloak', 'manifest.json'))).rejects.toThrow();
    expect(await readdir(store.root, { recursive: true })).toEqual(before);
    expect((await stat(join(store.root, 'key'))).ctimeMs).toBe(keyChanged);
    expect((await readdir(join(destination, '..'))).some((name) => name.includes('.lock'))).toBe(
      false,
    );
  });
  it('refreshes from a nested workspace using recorded paths and profiles', async () => {
    const { destination, source, store, push, options } = await fixture();
    await push('push', options);
    await writeFile(join(source, 'src', 'Acme.ts'), 'class Acme { changed = true }');
    const pull = createSyncCommand(createSyncServices(join(destination, 'src'), store), '2.0.0');
    await pull('pull', { yes: true });
    expect(await readFile(join(destination, 'src', 'Northwind.ts'), 'utf8')).toBe(
      'class Northwind { changed = true }',
    );
  });
  it('preserves workspace edits and refuses both-side changes before writing the manifest', async () => {
    const { destination, source, store, push, options } = await fixture();
    await push('push', options);
    const file = join(destination, 'src', 'Northwind.ts');
    await writeFile(file, 'workspace edit');
    const pull = createSyncCommand(createSyncServices(destination, store), '2.0.0');
    await pull('pull', { yes: true });
    expect(await readFile(file, 'utf8')).toBe('workspace edit');
    const before = await readFile(join(destination, '.repo-cloak', 'manifest.json'));
    await writeFile(join(source, 'src', 'Acme.ts'), 'source edit');
    await expect(pull('pull', { yes: true })).rejects.toThrow(/both/);
    expect(await readFile(file, 'utf8')).toBe('workspace edit');
    expect(await readFile(join(destination, '.repo-cloak', 'manifest.json'))).toEqual(before);
  });
  it('copies binary files unchanged and deletes only unchanged tracked files on refresh', async () => {
    const { destination, source, store, push, options } = await fixture();
    const bytes = Buffer.from([0, 255, 65, 99, 109, 101]);
    await writeFile(join(source, 'src', 'Acme.bin'), bytes);
    const first = await push('push', options);
    expect(first.warnings).toEqual(expect.arrayContaining([expect.stringContaining('binary')]));
    expect(await readFile(join(destination, 'src', 'Northwind.bin'))).toEqual(bytes);
    await rm(join(source, 'src', 'Acme.ts'));
    const pull = createSyncCommand(createSyncServices(destination, store), '2.0.0');
    await pull('pull', { yes: true });
    expect(await readdir(join(destination, 'src'))).toEqual(['Northwind.bin']);
  });
  it('uses its own Git branch and commits only extraction changes', async () => {
    const { destination, source, store, push, options } = await fixture(true);
    await push('push', options);
    expect((await runGit(destination, ['branch', '--show-current'])).trim()).toBe('cloak');
    expect((await runGit(destination, ['status', '--porcelain'])).trim()).toBe('');
    await writeFile(join(destination, 'notes.txt'), 'agent notes');
    await runGit(destination, ['add', '--', 'notes.txt']);
    await writeFile(join(source, 'src', 'Acme.ts'), 'class Acme { source = true }');
    const pull = createSyncCommand(createSyncServices(destination, store), '2.0.0');
    await pull('pull', { yes: true });
    expect(await runGit(destination, ['diff', '--cached', '--name-only'])).toContain('notes.txt');
    expect(await runGit(destination, ['show', '--format=', '--name-only', 'HEAD'])).not.toContain(
      'notes.txt',
    );
  });
  it('refuses foreign destinations and authenticates manifest metadata', async () => {
    const { destination, source, push, options, services } = await fixture();
    await expect(push('push', { ...options, to: join(source, 'nested') })).rejects.toThrow(
      /separate|inside/,
    );
    await push('push', options);
    const path = join(destination, '.repo-cloak', 'manifest.json');
    const raw = JSON.parse(await readFile(path, 'utf8')) as { workspaceId: string };
    raw.workspaceId = 'tampered';
    await writeFile(path, JSON.stringify(raw));
    await expect(services.store.readSnapshot(destination)).rejects.toThrow(/authenticate/);
  });
});

it('rolls workspace files and manifest back after a write failure', async () => {
  const { source, destination, services, store, push, options } = await fixture();
  await push('push', options);
  const beforeFile = await readFile(join(destination, 'src', 'Northwind.ts'));
  const beforeManifest = await readFile(join(destination, '.repo-cloak', 'manifest.json'));
  await writeFile(join(source, 'src', 'Acme.ts'), 'class Acme { changed = true }');
  const { createWorkspaceWriter } = await import('../src/adapters/workspace.js');
  const { writeAtomic } = await import('../src/adapters/atomic.js');
  const pullServices = createSyncServices(destination, store);
  pullServices.writeWorkspace = createWorkspaceWriter(async (path, bytes) => {
    if (path.endsWith('manifest.json')) throw new Error('Simulated write failure');
    await writeAtomic(path, bytes);
  });
  await expect(createSyncCommand(pullServices, '2.0.0')('pull', { yes: true })).rejects.toThrow(
    /Simulated/,
  );
  expect(await readFile(join(destination, 'src', 'Northwind.ts'))).toEqual(beforeFile);
  expect(await readFile(join(destination, '.repo-cloak', 'manifest.json'))).toEqual(beforeManifest);
  expect((await services.store.readSnapshot(destination))?.plain.pulls).toHaveLength(1);
});

it('detects source edits between preview and applying the plan', async () => {
  const { source, destination, services, options } = await fixture();
  services.interactive = true;
  services.confirmPull = async () => {
    await writeFile(join(source, 'src', 'Acme.ts'), 'changed during preview');
    return true;
  };
  await expect(
    createSyncCommand(services, '2.0.0')('push', { ...options, yes: false }),
  ).rejects.toThrow(/Source files changed/);
  await expect(readdir(destination)).rejects.toThrow();
});

it('selects a union of explicit, committed, and working files once', async () => {
  const { source, push, options } = await fixture();
  await writeFile(join(source, 'committed.ts'), 'Acme');
  await runGit(source, ['add', '--', 'committed.ts']);
  await runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'selected file',
  ]);
  await writeFile(join(source, 'working.ts'), 'Acme');
  const result = await push('push', {
    ...options,
    files: ['src', 'committed.ts'],
    commits: ['HEAD'],
    working: true,
  });
  expect(result.writes).toEqual(['committed.ts', 'src/Northwind.ts', 'working.ts']);
});

it('uses an anonymized default directory and requires --to when several workspaces match', async () => {
  const { root, destination, services, push, options } = await fixture();
  await services.store.saveConfig({
    kind: 'config',
    schemaVersion: 1,
    initGit: false,
    workspacesRoot: join(root, 'cloak'),
  });
  const { to: _destination, ...withoutDestination } = options;
  void _destination;
  const first = await push('push', withoutDestination);
  expect(first.workspace).toContain('northwind-source-');
  await push('push', options);
  await expect(push('push', { yes: true })).rejects.toThrow(/Several.*--to/);
  expect((await push('push', { to: destination, yes: true })).status).toBe('written');
});

it('refreshes a linked worktree after git worktree move', async () => {
  const { root, source, destination, store, options } = await fixture();
  await runGit(source, ['add', '--', 'src']);
  await runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'source',
  ]);
  const linked = join(root, 'acme-feature');
  const moved = join(root, 'acme-moved');
  await runGit(source, ['worktree', 'add', '-b', 'feature', linked]);
  await createSyncCommand(createSyncServices(linked, store), '2.0.0')('push', options);
  await runGit(source, ['worktree', 'move', linked, moved]);
  await writeFile(join(moved, 'src', 'Acme.ts'), 'class Acme { moved = true }');
  await createSyncCommand(createSyncServices(destination, store), '2.0.0')('pull', { yes: true });
  expect(await readFile(join(destination, 'src', 'Northwind.ts'), 'utf8')).toBe(
    'class Northwind { moved = true }',
  );
});

it('holds the workspace lock until its private record and backup are saved', async () => {
  const { destination, services, store, push, options } = await fixture();
  let entered = () => {};
  let release = () => {};
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const record = services.store.record;
  services.store.record = async (...args) => {
    entered();
    await ready;
    await record(...args);
  };
  const first = push('push', options);
  await saving;
  try {
    const second = createSyncCommand(createSyncServices(destination, store), '2.0.0');
    await expect(second('pull', { yes: true })).rejects.toThrow(/lock/i);
  } finally {
    release();
    await first;
  }
});

it('commits source deletions in the workspace Git snapshot', async () => {
  const { source, destination, store, push, options } = await fixture(true);
  await push('push', options);
  await rm(join(source, 'src', 'Acme.ts'));
  await createSyncCommand(createSyncServices(destination, store), '2.0.0')('pull', { yes: true });
  expect((await runGit(destination, ['status', '--porcelain'])).trim()).toBe('');
  expect(await runGit(destination, ['show', '--format=', '--name-status', 'HEAD'])).toContain(
    'D\tsrc/Northwind.ts',
  );
});

describe('restoring workspace changes', () => {
  async function restoredFixture() {
    const setup = await fixture();
    await setup.push('push', setup.options);
    const services = createSyncServices(setup.destination, setup.store);
    services.interactive = false;
    return { ...setup, restoreServices: services, restore: createSyncCommand(services, '2.0.0') };
  }
  it('restores edits and new names, preserves BOM/CRLF, and skips a repeated restore', async () => {
    const { destination, source, restore, services, push, options } = await restoredFixture();
    await writeFile(
      join(destination, 'src', 'Northwind.ts'),
      '\uFEFFexport class Northwind { newValue = true }\r\n',
    );
    await writeFile(join(destination, 'src', 'NorthwindClient.ts'), 'class NorthwindClient {}');
    const result = await restore('push', { yes: true });
    expect(result.writes).toEqual(['src/Acme.ts', 'src/AcmeClient.ts']);
    expect(await readFile(join(source, 'src', 'Acme.ts'), 'utf8')).toBe(
      '\uFEFFexport class Acme { newValue = true }\r\n',
    );
    expect(await readFile(join(source, 'src', 'AcmeClient.ts'), 'utf8')).toBe(
      'class AcmeClient {}',
    );
    expect((await restore('push', { yes: true })).writes).toEqual([]);
    expect(
      Object.keys((await services.store.readSnapshot(destination))?.plain.files ?? {}),
    ).toContain('src/NorthwindClient.ts');
    // The updated ledger baseline remains usable for later extraction.
    await push('push', { ...options, files: [] });
  });
  it('stops all writes on conflicts, can skip them, or explicitly force them', async () => {
    const { source, destination, restore } = await restoredFixture();
    await writeFile(join(source, 'src', 'Acme.ts'), 'source changed');
    await writeFile(join(destination, 'src', 'Northwind.ts'), 'class Northwind { edited = true }');
    await writeFile(join(destination, 'new.txt'), 'new file');
    const manifest = await readFile(join(destination, '.repo-cloak', 'manifest.json'));
    await expect(restore('push', { yes: true })).rejects.toMatchObject({ exitCode: 2 });
    await expect(readFile(join(source, 'new.txt'))).rejects.toThrow();
    expect(await readFile(join(destination, '.repo-cloak', 'manifest.json'))).toEqual(manifest);
    const skipped = await restore('push', { yes: true, skipConflicts: true });
    expect(skipped.writes).toEqual(['new.txt']);
    expect(skipped.skipped).toBe(1);
    expect(await readFile(join(source, 'src', 'Acme.ts'), 'utf8')).toBe('source changed');
    await restore('push', { yes: true, force: true });
    expect(await readFile(join(source, 'src', 'Acme.ts'), 'utf8')).toBe(
      'class Acme { edited = true }',
    );
  });
  it('does not touch an unchanged workspace file even if its source changed', async () => {
    const { source, restore } = await restoredFixture();
    await writeFile(join(source, 'src', 'Acme.ts'), 'source changed');
    expect((await restore('push', { yes: true })).writes).toEqual([]);
    expect(await readFile(join(source, 'src', 'Acme.ts'), 'utf8')).toBe('source changed');
  });
  it('confirms source deletions and supports cancellation', async () => {
    const { source, destination, restoreServices, restore } = await restoredFixture();
    await rm(join(destination, 'src', 'Northwind.ts'));
    restoreServices.interactive = true;
    let deletions: string[] = [];
    restoreServices.confirmPush = async (plan) => {
      deletions = plan.deletes;
      return false;
    };
    expect((await restore('push', {})).status).toBe('cancelled');
    expect(deletions).toEqual(['src/Acme.ts']);
    expect(await readFile(join(source, 'src', 'Acme.ts'), 'utf8')).toContain('Acme');
    await restore('push', { yes: true });
    await expect(readFile(join(source, 'src', 'Acme.ts'))).rejects.toThrow();
    expect((await restore('push', { yes: true })).deletes).toEqual([]);
  });
  it('dry-runs without changing files, manifest, key permissions, or records', async () => {
    const { source, destination, restore, store } = await restoredFixture();
    await writeFile(join(destination, 'src', 'Northwind.ts'), 'class Northwind { edited = true }');
    const manifest = await readFile(join(destination, '.repo-cloak', 'manifest.json'));
    const before = await readFile(join(source, 'src', 'Acme.ts'));
    const key = await stat(join(store.root, 'key'));
    const entries = await readdir(store.root, { recursive: true });
    expect((await restore('push', { dryRun: true })).status).toBe('dry-run');
    expect(await readFile(join(source, 'src', 'Acme.ts'))).toEqual(before);
    expect(await readFile(join(destination, '.repo-cloak', 'manifest.json'))).toEqual(manifest);
    expect((await stat(join(store.root, 'key'))).ctimeMs).toBe(key.ctimeMs);
    expect(await readdir(store.root, { recursive: true })).toEqual(entries);
  });
  it('rolls source changes and the baseline back when saving the manifest fails', async () => {
    const { source, destination, restoreServices } = await restoredFixture();
    const { createSourceWriter } = await import('../src/adapters/source-writer.js');
    const { writeAtomic } = await import('../src/adapters/atomic.js');
    const before = await readFile(join(source, 'src', 'Acme.ts'));
    const manifest = await readFile(join(destination, '.repo-cloak', 'manifest.json'));
    await writeFile(join(destination, 'src', 'Northwind.ts'), 'class Northwind { edited = true }');
    await writeFile(join(destination, 'new.txt'), 'new file');
    restoreServices.writeSource = createSourceWriter(async (path, bytes) => {
      if (path.endsWith('manifest.json')) throw new Error('Simulated manifest failure');
      await writeAtomic(path, bytes);
    });
    await expect(
      createSyncCommand(restoreServices, '2.0.0')('push', { yes: true }),
    ).rejects.toThrow('Simulated');
    expect(await readFile(join(source, 'src', 'Acme.ts'))).toEqual(before);
    expect(await readFile(join(destination, '.repo-cloak', 'manifest.json'))).toEqual(manifest);
    await expect(readFile(join(source, 'new.txt'))).rejects.toThrow();
  });
  it('rejects source changes made during confirmation', async () => {
    const { source, destination, restoreServices, restore } = await restoredFixture();
    await writeFile(join(destination, 'src', 'Northwind.ts'), 'class Northwind { edited = true }');
    restoreServices.interactive = true;
    restoreServices.confirmPush = async () => {
      await writeFile(join(source, 'src', 'Acme.ts'), 'changed during confirmation');
      return true;
    };
    await expect(restore('push', {})).rejects.toThrow('Source files changed');
    expect(await readFile(join(source, 'src', 'Acme.ts'), 'utf8')).toBe(
      'changed during confirmation',
    );
  });
  it('asks which linked workspace to restore and requires --from without a terminal', async () => {
    const { destination, root, services, push, options } = await restoredFixture();
    await push('push', { ...options, to: join(root, 'second') });
    await expect(push('pull', { yes: true })).rejects.toThrow(/Several.*--from/);
    services.interactive = true;
    let choices: string[] = [];
    services.chooseWorkspace = async (paths) => {
      choices = paths;
      return destination;
    };
    services.confirmPush = async () => true;
    expect((await push('pull', {})).workspace).toBe(destination);
    expect(choices).toHaveLength(2);
    expect((await push('pull', { from: destination, yes: true })).workspace).toBe(destination);
  });
  it('refuses residue and existing source files before writing anything', async () => {
    const { source, destination, restore } = await restoredFixture();
    await writeFile(join(destination, 'src', 'Northwind.ts'), 'NORTHWindology');
    await expect(restore('push', { yes: true })).rejects.toThrow(/anonymized|residue/i);
    await writeFile(join(destination, 'src', 'Northwind.ts'), 'class Northwind {}');
    await writeFile(join(destination, 'new.txt'), 'workspace');
    await writeFile(join(source, 'new.txt'), 'source');
    await expect(restore('push', { yes: true })).rejects.toMatchObject({ exitCode: 2 });
    expect(await readFile(join(source, 'new.txt'), 'utf8')).toBe('source');
  });
});

it('lists workspaces by recency and hides missing directories', async () => {
  const { destination, root, services, push, options } = await fixture();
  const { listWorkspaces } = await import('../src/commands/workspaces.js');
  services.now = () => '2026-10-16T00:00:00Z';
  await push('push', options);
  const second = join(root, 'second');
  services.now = () => '2026-10-17T00:00:00Z';
  await push('push', { ...options, to: second });
  expect((await listWorkspaces(services)).map((item) => item.path)).toEqual([second, destination]);
  await rm(second, { recursive: true });
  expect((await listWorkspaces(services)).map((item) => item.path)).toEqual([destination]);
});

it('refuses new restore files inside nested source repositories', async () => {
  const { source, destination, store, push, options } = await fixture();
  await push('push', options);
  await mkdir(join(source, 'nested'));
  await runGit(join(source, 'nested'), ['init', '-b', 'main']);
  await mkdir(join(destination, 'nested'));
  await writeFile(join(destination, 'nested', 'new.txt'), 'new file');
  const restore = createSyncCommand(createSyncServices(destination, store), '2.0.0');
  await expect(restore('push', { yes: true })).rejects.toThrow('nested repository');
  await expect(readFile(join(source, 'nested', 'new.txt'))).rejects.toThrow();
});
