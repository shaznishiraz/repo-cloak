import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createSyncStore } from '../../src/adapters/sync-store.js';
import { createDashboard } from '../../src/application/dashboard.js';

it('keeps the registered repo path when work targets another worktree', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak repo path ')));
  const store = createStore(join(root, 'store'));
  const dashboard = createDashboard(store, root);
  try {
    const services = createSyncServices(root, store);
    await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
    const source = join(root, 'Source');
    const second = join(root, 'Second');
    await mkdir(source);
    const git = (...args: string[]) => services.git.runGit(source, args);
    await git('init', '-b', 'main');
    await git('config', 'user.email', 't@example.com');
    await git('config', 'user.name', 't');
    await git('config', 'commit.gpgSign', 'false');
    await writeFile(join(source, 'a.ts'), 'a\n');
    await git('add', '-A');
    await git('commit', '-qm', 'initial');
    await git('worktree', 'add', '-q', '-b', 'second', second);
    const { repoId } = await dashboard.addRepository({ path: source });
    const profile = await dashboard.saveProfile({
      scope: { kind: 'repo', repoId },
      profile: { kind: 'profile', schemaVersion: 1, name: 'p', rules: [] },
    });
    const create = async (destination: string) => {
      const preview = await dashboard.sync.preview({
        intent: 'create',
        repoId,
        worktree: second,
        destination: join(root, destination),
        files: ['a.ts'],
        profiles: [{ id: profile.id, scope: profile.scope }],
      });
      await dashboard.sync.apply(preview.operationId, {});
      expect((await dashboard.sync.wait(preview.operationId)).state).toBe('completed');
    };
    const syncStore = createSyncStore(store);
    await create('one');
    expect((await syncStore.readRepo(repoId))?.path).toBe(source);
  } finally {
    dashboard.sync.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
