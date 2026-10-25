import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createTestSync } from '../support/sync.js';
import { createDashboard } from '../../src/application/dashboard.js';

it('opens on the current repo or workspace and exposes real status and pull history', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak dashboard data ')));
  try {
    const source = join(root, 'source');
    const destination = join(root, 'workspace');
    await mkdir(source);
    const store = createStore(join(root, 'store'));
    const services = createSyncServices(source, store);
    await services.git.runGit(source, ['init', '-b', 'main']);
    await writeFile(join(source, 'Acme.ts'), 'class Acme {}');
    const dashboard = createDashboard(store, source);
    const context = await dashboard.context();
    expect(context.repoId).toMatch(/^[a-f0-9]{16}$/);
    expect(await dashboard.overview()).toHaveLength(1);
    const profile = await dashboard.saveProfile({
      scope: { kind: 'repo', repoId: context.repoId },
      profile: {
        kind: 'profile',
        schemaVersion: 1,
        name: 'names',
        extensions: { custom: true },
        rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
      },
    });
    expect(profile.profile.extensions).toEqual({ custom: true });
    await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
    const result = await createTestSync(services, '2.0.0')('push', {
      profiles: ['names'],
      files: ['Acme.ts'],
      to: destination,
    });
    expect((await dashboard.overview())[0]?.workspaces[0]).toMatchObject({
      id: result.workspaceId,
      worktree: source,
      missing: false,
    });
    await writeFile(join(destination, 'Northwind.ts'), 'class Northwind { edited = true }');
    const repoId = context.repoId ?? '';
    const detail = await dashboard.workspace(repoId, result.workspaceId);
    expect(detail.status.modified).toEqual(['Northwind.ts']);
    expect(detail.history).toHaveLength(1);
    expect(detail.profiles).toEqual(['names']);
    expect((await createDashboard(store, destination).context()).workspaceId).toBe(
      result.workspaceId,
    );
    expect((await dashboard.profiles(repoId))[0]?.id).toBe(profile.id);
    await expect(dashboard.workspace(repoId, '__proto__')).rejects.toThrow('not registered');
    await expect(
      dashboard.saveProfile({
        scope: { kind: 'repo', repoId: 'ffffffffffffffff' },
        profile: profile.profile,
      }),
    ).rejects.toThrow('not registered');
    const before = await readFile(join(destination, '.repo-cloak', 'manifest.json'));
    await dashboard.workspace(repoId, result.workspaceId);
    expect(await readFile(join(destination, '.repo-cloak', 'manifest.json'))).toEqual(before);
    await services.git.runGit(source, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'commit.gpgSign=false',
      '-c',
      `core.hooksPath=${join(root, 'no-hooks')}`,
      'commit',
      '--allow-empty',
      '-m',
      'Initial',
    ]);
    const otherWorktree = join(root, 'feature');
    await services.git.runGit(source, ['worktree', 'add', '-b', 'feature', otherWorktree]);
    await mkdir(join(otherWorktree, 'nested'));
    await writeFile(join(otherWorktree, 'nested', 'Acme.ts'), 'class Acme {}');
    expect(await createDashboard(store, join(otherWorktree, 'nested')).context()).toEqual({
      repoId,
      worktree: otherWorktree,
    });
    // The existing workspace belongs to main, not the newly launched feature worktree.
    expect(
      (await dashboard.overview())[0]?.workspaces.map((workspace) => workspace.worktree),
    ).toEqual([source]);
    const other = await createTestSync(createSyncServices(otherWorktree, store), '2.0.0')('push', {
      profiles: ['names'],
      files: ['nested/Acme.ts'],
      to: join(root, 'feature-cloak'),
    });
    expect((await dashboard.overview())[0]?.workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: result.workspaceId, worktree: source }),
        expect.objectContaining({ id: other.workspaceId, worktree: otherWorktree }),
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
