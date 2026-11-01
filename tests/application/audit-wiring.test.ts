import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { hashBytes } from '../../src/core/hash.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak audit wiring ')));
  roots.push(root);
  const source = join(root, 'Acme');
  const destination = join(root, 'workspace');
  await mkdir(source);
  const store = createStore(join(root, 'store'));
  const services = createSyncServices(source, store);
  await services.git.runGit(source, ['init', '-b', 'main']);
  await services.git.runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'initial',
  ]);
  await writeFile(join(source, 'Acme.ts'), 'class Acme {}');
  const dashboard = createDashboard(store, source);
  const { repoId = '' } = await dashboard.context();
  const profile = await dashboard.saveProfile({
    scope: { kind: 'global' },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'names',
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    },
  });
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  const run = async (input: unknown) => {
    const preview = await dashboard.sync.preview(input);
    await dashboard.sync.apply(preview.operationId, {});
    const done = await dashboard.sync.wait(preview.operationId);
    expect(done.state).toBe('completed');
    return done;
  };
  return { root, source, destination, store, dashboard, repoId, profile, run };
}

it('logs create, pull, push, delete and settings with hashes but never contents', async () => {
  const f = await fixture();
  const events = async () => (await f.dashboard.sync.audit.list()).events.reverse();
  const created = await f.run({
    intent: 'create',
    repoId: f.repoId,
    worktree: f.source,
    destination: f.destination,
    profiles: [{ id: f.profile.id, scope: f.profile.scope }],
    files: ['Acme.ts'],
  });
  const workspaceId = created.result?.workspaceId ?? '';
  const [create] = await events();
  expect(create).toMatchObject({
    op: 'create',
    outcome: 'ok',
    workspace: { repoId: f.repoId, id: workspaceId, name: 'workspace' },
    files: [{ path: 'Northwind.ts', hash: hashBytes(Buffer.from('class Northwind {}')) }],
    profiles: [{ id: f.profile.id, hash: expect.any(String) }],
    keyId: expect.stringMatching(/^k_/),
  });

  await writeFile(join(f.source, 'Acme.ts'), 'class Acme { source = true }');
  await f.run({ intent: 'refresh', repoId: f.repoId, workspaceId, worktree: f.source });
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { agent = true }');
  await f.run({ intent: 'restore', repoId: f.repoId, workspaceId, worktree: f.source });
  await f.dashboard.settings.save({ postCreateCommands: ['echo private-value'] });
  await f.dashboard.settings.save({ postCreateCommands: ['echo private-value'] });
  await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['*.secret'] });
  await f.dashboard.deleteWorkspace(f.repoId, workspaceId, {
    path: f.destination,
    confirm: true,
  });

  const log = await events();
  expect(log.map((event) => event.op)).toEqual([
    'create',
    'pull',
    'push',
    'settings',
    'settings',
    'delete',
  ]);
  const push = log[2];
  expect(push?.files).toEqual([
    { path: 'Acme.ts', hash: hashBytes(Buffer.from('class Acme { agent = true }')) },
  ]);
  expect(log[3]?.detail).toBe('Changed postCreateCommands');
  expect(log.at(-1)).toMatchObject({ op: 'delete', workspace: { id: workspaceId } });
  const text = JSON.stringify(log);
  expect(text).not.toContain('class Acme');
  expect(text).not.toContain('private-value');
  expect(await f.dashboard.sync.audit.verify()).toMatchObject({ ok: true, count: 6 });
});

it('records a failed delete as failed and leaves nothing applied silently', async () => {
  const f = await fixture();
  const created = await f.run({
    intent: 'create',
    repoId: f.repoId,
    worktree: f.source,
    destination: f.destination,
    profiles: [{ id: f.profile.id, scope: f.profile.scope }],
    files: ['Acme.ts'],
  });
  await expect(
    f.dashboard.deleteWorkspace(f.repoId, created.result?.workspaceId ?? '', {
      path: '/different',
      confirm: true,
    }),
  ).rejects.toThrow();
  const { events } = await f.dashboard.sync.audit.list();
  expect(events[0]).toMatchObject({ op: 'delete', outcome: 'failed' });
});
