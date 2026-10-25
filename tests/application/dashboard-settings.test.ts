import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createDashboard } from '../../src/application/dashboard.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { browseFolders } from '../../src/adapters/folders.js';
import { createTestSync } from '../support/sync.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak defaults ')));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await mkdir(join(source, 'src'));
  await writeFile(join(source, 'src', 'Acme.ts'), 'class Acme {}');
  const store = createStore(join(root, 'store'));
  const services = createSyncServices(source, store);
  await services.git.runGit(source, ['init', '-b', 'main']);
  await services.store.saveConfig({
    kind: 'config',
    schemaVersion: 1,
    initGit: false,
    extensions: { preserved: true },
  });
  const dashboard = createDashboard(store, source);
  const { repoId } = await dashboard.context();
  const saved = await dashboard.saveProfile({
    scope: { kind: 'global' },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'names',
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    },
  });
  return {
    root,
    source,
    store,
    services,
    dashboard,
    repoId,
    input: {
      intent: 'create',
      repoId,
      worktree: source,
      files: ['src'],
      profiles: [{ id: saved.id, scope: saved.scope }],
    },
  };
}
it('saves global defaults, preserves other settings, and rejects roots inside source or cloak repos', async () => {
  const f = await fixture();
  const folder = join(f.root, 'cloaks');
  expect(
    await f.dashboard.settings.save({ workspacesRoot: folder, postCreateCommands: [] }),
  ).toEqual({ workspacesRoot: folder, postCreateCommands: [] });
  expect(await f.services.store.readConfig()).toMatchObject({
    initGit: false,
    extensions: { preserved: true },
  });
  await expect(
    f.dashboard.settings.save({ workspacesRoot: join(f.source, 'cloaks') }),
  ).rejects.toThrow(/outside/);
  await expect(f.dashboard.settings.save({ workspacesRoot: 'relative' })).rejects.toThrow(
    /absolute/,
  );
  await expect(f.dashboard.settings.save({ postCreateCommands: [''] })).rejects.toThrow();
  const preview = await f.dashboard.sync.preview(f.input);
  expect(preview.destination.path.startsWith(folder)).toBe(true);
  await f.dashboard.sync.apply(preview.operationId, {});
  const created = await f.dashboard.sync.wait(preview.operationId);
  await expect(
    f.dashboard.settings.save({ workspacesRoot: join(created.result?.workspace ?? '', 'nested') }),
  ).rejects.toThrow(/outside/);
});
it('previews post commands without side effects, saves defaults only on apply and executes once in the new workspace', async () => {
  const f = await fixture();
  const command = "node -e \"require('node:fs').writeFileSync('setup.txt',process.cwd())\"";
  const preview = await f.dashboard.sync.preview({
    ...f.input,
    workspacesRoot: join(f.root, 'cloaks'),
    postCreateCommands: [command],
    saveDefaults: true,
  });
  expect(preview.postCreateCommands).toEqual([command]);
  expect((await f.dashboard.settings.read()).workspacesRoot).toBe('');
  await expect(readFile(join(preview.destination.path, 'setup.txt'))).rejects.toThrow();
  await f.dashboard.sync.apply(preview.operationId, {});
  const created = await f.dashboard.sync.wait(preview.operationId);
  expect(created.result?.postCommands).toEqual([{ command, status: 'completed', exitCode: 0 }]);
  expect(await readFile(join(preview.destination.path, 'setup.txt'), 'utf8')).toBe(
    preview.destination.path,
  );
  expect((await f.dashboard.settings.read()).workspacesRoot).toBe(join(f.root, 'cloaks'));
  await rm(join(preview.destination.path, 'setup.txt'));
  await f.dashboard.sync.apply(preview.operationId, {});
  const refresh = await f.dashboard.sync.preview({
    intent: 'refresh',
    repoId: f.repoId,
    workspaceId: created.result?.workspaceId,
    worktree: f.source,
  });
  expect(refresh.postCreateCommands).toEqual([]);
  await f.dashboard.sync.apply(refresh.operationId, {});
  await f.dashboard.sync.wait(refresh.operationId);
  await expect(readFile(join(preview.destination.path, 'setup.txt'))).rejects.toThrow();
});
it('reports a failed command, keeps the created workspace and stops the remaining commands', async () => {
  const f = await fixture();
  await f.dashboard.settings.save({
    workspacesRoot: join(f.root, 'cloaks'),
    postCreateCommands: [
      'node -e "process.exit(7)"',
      "node -e \"require('node:fs').writeFileSync('not-run.txt','bad')\"",
    ],
  });
  const run = createTestSync(f.services, '2.0.0');
  const result = await run('push', {
    profiles: ['names'],
    files: ['src'],
    newWorkspace: true,
  });
  expect(result.status).toBe('written');
  expect('postCommands' in result && result.postCommands).toEqual([
    { command: 'node -e "process.exit(7)"', status: 'failed', exitCode: 7 },
  ]);
  expect(await readFile(join(result.workspace, 'src', 'Northwind.ts'), 'utf8')).toBe(
    'class Northwind {}',
  );
  await expect(readFile(join(result.workspace, 'not-run.txt'))).rejects.toThrow();
});
it('browses local destination folders and immediate source folders without crossing the repo boundary', async () => {
  const f = await fixture();
  const local = await browseFolders(f.root);
  expect(local.folders.map((folder) => folder.name)).toContain('source');
  const source = await f.dashboard.sync.selection(f.repoId ?? '', f.source, 0, '', [], '');
  expect(source.directories).toEqual(['src']);
  expect(source.files).toEqual([]);
  const nested = await f.dashboard.sync.selection(f.repoId ?? '', f.source, 0, '', [], 'src');
  expect(nested.files).toEqual(['src/Acme.ts']);
  await expect(
    f.dashboard.sync.selection(f.repoId ?? '', f.source, 0, '', [], '../'),
  ).rejects.toThrow();
  const all = await f.dashboard.sync.preview({
    ...f.input,
    files: ['.'],
    workspacesRoot: join(f.root, 'cloaks'),
  });
  expect(all.writes).toEqual(['src/Northwind.ts']);
});
