import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { afterEach, expect, it } from 'vitest';
import { createDashboard } from '../../src/commands/dashboard.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createSyncCommand } from '../../src/commands/sync.js';
import { hashJson } from '../../src/core/hash.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak delete ')));
  roots.push(root);
  const source = join(root, 'source');
  const destination = join(root, 'cloak');
  await mkdir(source);
  const store = createStore(join(root, 'store'));
  const services = createSyncServices(source, store);
  await services.git.runGit(source, ['init', '-b', 'main']);
  await writeFile(join(source, 'Acme.ts'), 'class Acme {}');
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  await services.profiles.save(
    { kind: 'global' },
    {
      kind: 'profile',
      schemaVersion: 1,
      name: 'names',
      rules: [{ id: 'name', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    },
  );
  const result = await createSyncCommand(services, '2.0.0')('push', {
    files: ['Acme.ts'],
    profiles: ['names'],
    to: destination,
    yes: true,
  });
  const repoId = (await services.git.repoState(source)).repoId;
  const dashboard = createDashboard(store, source);
  const input = { path: destination, confirm: true };
  return {
    root,
    source,
    destination,
    store,
    services,
    dashboard,
    repoId,
    id: result.workspaceId,
    input,
  };
}
it('deletes all cloak files, Git metadata, registration and backup while preserving source and profiles', async () => {
  const f = await fixture();
  await f.services.git.runGit(f.destination, ['init', '-b', 'cloak']);
  await writeFile(join(f.destination, '.git', 'private-history'), 'history');
  await writeFile(join(f.destination, 'unsynced.txt'), 'unsynced');
  const backup = join(
    f.store.root,
    'repos',
    f.repoId,
    'manifests',
    `${hashJson(f.id).slice(7)}.json`,
  );
  await expect(readFile(backup)).resolves.toBeDefined();
  expect(await f.dashboard.deleteWorkspace(f.repoId, f.id, f.input)).toEqual({ deleted: f.id });
  await expect(readFile(join(f.destination, 'unsynced.txt'))).rejects.toThrow();
  await expect(readFile(backup)).rejects.toThrow();
  expect((await f.services.store.readRepo(f.repoId))?.workspaces).toEqual({});
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme {}');
  expect(await f.services.profiles.list({ kind: 'global' })).toHaveLength(1);
});
it('requires exact confirmation and rejects a busy workspace', async () => {
  const f = await fixture();
  await expect(
    f.dashboard.deleteWorkspace(f.repoId, f.id, { ...f.input, confirm: false }),
  ).rejects.toThrow();
  await expect(
    f.dashboard.deleteWorkspace(f.repoId, f.id, { ...f.input, path: f.source }),
  ).rejects.toThrow('registration changed');
  const release = await lock(f.destination);
  try {
    await expect(f.dashboard.deleteWorkspace(f.repoId, f.id, f.input)).rejects.toThrow();
  } finally {
    await release();
  }
  expect(await readFile(join(f.destination, 'Northwind.ts'), 'utf8')).toBe('class Northwind {}');
});
it('can remove a missing workspace registration', async () => {
  const f = await fixture();
  await rm(f.destination, { recursive: true });
  await f.dashboard.deleteWorkspace(f.repoId, f.id, f.input);
  expect((await f.services.store.readRepo(f.repoId))?.workspaces).toEqual({});
});
it('rejects an existing directory without an authenticated matching manifest', async () => {
  const f = await fixture();
  await rm(join(f.destination, '.repo-cloak', 'manifest.json'));
  await expect(f.dashboard.deleteWorkspace(f.repoId, f.id, f.input)).rejects.toThrow('manifest');
  expect(await readFile(join(f.destination, 'Northwind.ts'), 'utf8')).toBe('class Northwind {}');
});
it('protects a source directory even if a registration is redirected there', async () => {
  const f = await fixture();
  const record = await f.services.store.readRepo(f.repoId);
  if (!record) throw new Error('Missing record');
  const entry = record.workspaces[f.id];
  if (!entry) throw new Error('Missing workspace');
  entry.path = f.source;
  await f.store.writeSealed(`repos/${f.repoId}/repo.json`, f.repoId, 'repo', record);
  await expect(
    f.dashboard.deleteWorkspace(f.repoId, f.id, { path: f.source, confirm: true }),
  ).rejects.toThrow('Refusing');
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme {}');
});
it('restores the directory when unregistering fails', async () => {
  const f = await fixture();
  const broken = {
    ...f.store,
    writeSealed: async () => {
      throw new Error('write failed');
    },
  };
  await expect(
    createDashboard(broken, f.source).deleteWorkspace(f.repoId, f.id, f.input),
  ).rejects.toThrow('write failed');
  expect(await readFile(join(f.destination, 'Northwind.ts'), 'utf8')).toBe('class Northwind {}');
  expect((await f.services.store.readRepo(f.repoId))?.workspaces[f.id]?.path).toBe(f.destination);
});
it.skipIf(process.platform === 'win32')('rejects directory symlinks', async () => {
  const f = await fixture();
  await rm(f.destination, { recursive: true });
  await symlink(f.source, f.destination, 'dir');
  await expect(f.dashboard.deleteWorkspace(f.repoId, f.id, f.input)).rejects.toThrow('symlink');
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme {}');
});
