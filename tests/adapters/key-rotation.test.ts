import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { keyId } from '../../src/adapters/crypto.js';
import { createKeyStorage } from '../../src/adapters/key-storage.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { createFakeKeychain } from '../support/fake-keychain.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(keychain = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak rotate ')));
  roots.push(root);
  const source = join(root, 'Acme');
  const destination = join(root, 'workspace');
  await mkdir(source);
  const storeRoot = join(root, 'store');
  const fake = createFakeKeychain();
  const store = keychain
    ? createStore(storeRoot, createKeyStorage(storeRoot, { keychain: fake.keychain }))
    : createStore(storeRoot);
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
  const preview = await dashboard.sync.preview({
    intent: 'create',
    repoId,
    worktree: source,
    destination,
    profiles: [{ id: profile.id, scope: profile.scope }],
    files: ['Acme.ts'],
  });
  await dashboard.sync.apply(preview.operationId, {});
  const done = await dashboard.sync.wait(preview.operationId);
  const workspaceId = done.result?.workspaceId ?? '';
  return { root, source, destination, store, dashboard, repoId, workspaceId, profile, fake };
}
const manifestKey = async (workspace: string) =>
  (
    JSON.parse(await readFile(join(workspace, '.repo-cloak/manifest.json'), 'utf8')) as {
      sealed: { keyId: string };
    }
  ).sealed.keyId;

it.each([[false], [true]])(
  'reseals store, manifests and audit under a new key (keychain=%s)',
  async (keychain) => {
    const f = await fixture(keychain);
    const before = (await f.store.keyStatus()).keyId;
    const result = await f.dashboard.security.rotateKey();
    expect(result.previousKeyId).toBe(before);
    expect(result.keyId).not.toBe(before);
    expect(result.pending).toEqual([]);
    expect(result.resealed).toBeGreaterThan(2);
    expect(await manifestKey(f.destination)).toBe(result.keyId);
    expect(await f.store.keyStatus()).toMatchObject({
      keyId: result.keyId,
      rotationPending: false,
    });
    expect(await f.store.keys.retired()).toBeUndefined();
    // Everything still opens, and work continues under the new key.
    expect((await f.dashboard.profiles()).map((p) => p.profile.name)).toEqual(['names']);
    await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { edited = true }');
    const push = await f.dashboard.sync.preview({
      intent: 'restore',
      repoId: f.repoId,
      workspaceId: f.workspaceId,
      worktree: f.source,
    });
    await f.dashboard.sync.apply(push.operationId, {});
    expect((await f.dashboard.sync.wait(push.operationId)).state).toBe('completed');
    expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme { edited = true }');
    // The audit log survived the reseal with its chain intact and records the rotation.
    expect(await f.dashboard.sync.audit.verify()).toMatchObject({ ok: true });
    const ops = (await f.dashboard.sync.audit.list()).events.map((event) => event.op);
    expect(ops).toContain('key-rotate');
    expect(ops).toContain('create');
  },
);

it('leaves no old key behind on disk or in the keychain', async () => {
  const f = await fixture(true);
  await f.dashboard.security.rotateKey();
  expect(f.fake.items.size).toBe(1);
  const files = await fixture();
  await files.dashboard.security.rotateKey();
  await expect(stat(join(files.store.root, 'key.previous'))).rejects.toThrow();
});

it('keeps the old key while a workspace is unreachable, then finishes on retry', async () => {
  const f = await fixture();
  const away = `${f.destination}-away`;
  await rename(f.destination, away);
  const first = await f.dashboard.security.rotateKey();
  expect(first.pending).toEqual([f.destination]);
  expect(await f.store.keyStatus()).toMatchObject({ rotationPending: true, keyId: first.keyId });
  expect(await f.store.keys.retired()).toBeDefined();
  await rename(away, f.destination);
  // The old manifest still opens while the rotation is pending.
  expect((await f.dashboard.workspace(f.repoId, f.workspaceId)).trackedFiles).toBe(1);
  const second = await f.dashboard.security.rotateKey();
  expect(second).toMatchObject({
    keyId: first.keyId,
    previousKeyId: first.previousKeyId,
    pending: [],
  });
  expect(await manifestKey(f.destination)).toBe(first.keyId);
  expect(await f.store.keys.retired()).toBeUndefined();
});

it('finishes after a crash midway, when the store holds a mix of both keys', async () => {
  const f = await fixture();
  const old = await f.store.keys.current();
  if (!old) throw new Error('No key');
  await f.store.keys.beginRotation(Buffer.alloc(32, 0x42));
  // Crash here: new writes use the new key, old data still opens.
  expect((await f.dashboard.profiles()).map((p) => p.profile.name)).toEqual(['names']);
  const result = await f.dashboard.security.rotateKey();
  expect(result.previousKeyId).toBe(keyId(old));
  expect(result.keyId).toBe(keyId(Buffer.alloc(32, 0x42)));
  expect(await manifestKey(f.destination)).toBe(result.keyId);
  expect(await f.store.keys.retired()).toBeUndefined();
});

it('still rotates after a crash that saved the old key but installed no new one', async () => {
  const f = await fixture();
  const old = await f.store.keys.current();
  await writeFile(join(f.store.root, 'key.previous'), old ?? '');
  const result = await f.dashboard.security.rotateKey();
  expect(result.keyId).not.toBe(result.previousKeyId);
  expect(await manifestKey(f.destination)).toBe(result.keyId);
});

it('changes nothing if a sealed document cannot be opened', async () => {
  const f = await fixture();
  const before = await f.store.keyStatus();
  const manifest = join(f.destination, '.repo-cloak/manifest.json');
  const doc = JSON.parse(await readFile(manifest, 'utf8')) as { workspaceId: string };
  doc.workspaceId = 'tampered';
  await writeFile(manifest, JSON.stringify(doc));
  await expect(f.dashboard.security.rotateKey()).rejects.toThrow();
  expect(await f.store.keyStatus()).toEqual(before);
});

it('refuses to rotate over a damaged audit log', async () => {
  const f = await fixture();
  const before = await f.store.keyStatus();
  await writeFile(join(f.store.root, 'audit', 'log.jsonl'), 'garbage\n');
  await expect(f.dashboard.security.rotateKey()).rejects.toThrow(/audit log is damaged/);
  expect(await f.store.keyStatus()).toEqual(before);
});

it('refuses migration while a rotation is unfinished, and audits a finished migration', async () => {
  const f = await fixture(true);
  await f.store.keys.migrate('file');
  await f.dashboard.security.migrateKey('keychain');
  expect(await f.store.keyStatus()).toMatchObject({ storage: 'keychain' });
  const { events } = await f.dashboard.sync.audit.list();
  expect(events[0]).toMatchObject({ op: 'key-migrate', detail: 'Moved key to keychain' });
  await f.store.keys.beginRotation(Buffer.alloc(32, 1));
  await expect(f.dashboard.security.migrateKey('file')).rejects.toThrow(/rotation/);
});
