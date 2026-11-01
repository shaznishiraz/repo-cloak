import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { keyId } from '../../src/adapters/crypto.js';
import { createKeyStorage } from '../../src/adapters/key-storage.js';
import type { KeyStorageSetting } from '../../src/adapters/key-storage.js';
import { createStore } from '../../src/adapters/store.js';
import { createFakeKeychain } from '../support/fake-keychain.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(setting?: KeyStorageSetting, available = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak keys ')));
  roots.push(root);
  const fake = createFakeKeychain(available);
  const keys = createKeyStorage(root, {
    keychain: fake.keychain,
    setting: async () => setting,
  });
  return { root, fake, keys };
}
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

it('auto puts a new key in the keychain and never writes a key file', async () => {
  const f = await fixture();
  const key = await f.keys.getOrCreate();
  expect(await exists(join(f.root, 'key'))).toBe(false);
  expect([...f.fake.items.values()]).toEqual([key]);
  expect(await f.keys.getOrCreate()).toEqual(key);
  expect(await f.keys.status()).toEqual({
    sealed: true,
    keyId: keyId(key),
    storage: 'keychain',
    migrationAvailable: false,
    rotationPending: false,
  });
});

it('reuses one key across a restart and concurrent first writers', async () => {
  const f = await fixture();
  const other = createKeyStorage(f.root, { keychain: f.fake.keychain });
  const [a, b] = await Promise.all([f.keys.getOrCreate(), other.getOrCreate()]);
  expect(a).toEqual(b);
  const restarted = createKeyStorage(f.root, { keychain: f.fake.keychain });
  expect(await restarted.current()).toEqual(a);
  expect(f.fake.items.size).toBe(1);
});

it('auto keeps an existing key file working and offers migration', async () => {
  const f = await fixture();
  const original = Buffer.alloc(32, 7);
  await writeFile(join(f.root, 'key'), original);
  expect(await f.keys.getOrCreate()).toEqual(original);
  expect(f.fake.items.size).toBe(0);
  expect(await f.keys.status()).toMatchObject({ storage: 'file', migrationAvailable: true });
});

it('auto falls back to a file when no keychain is reachable, without offering migration', async () => {
  const f = await fixture(undefined, false);
  const key = await f.keys.getOrCreate();
  expect(await readFile(join(f.root, 'key'))).toEqual(key);
  expect(await f.keys.status()).toMatchObject({ storage: 'file', migrationAvailable: false });
});

it('respects the file setting, and refuses keychain when none is reachable', async () => {
  const file = await fixture('file');
  const key = await file.keys.getOrCreate();
  expect(await readFile(join(file.root, 'key'))).toEqual(key);
  expect(file.fake.items.size).toBe(0);
  expect(await file.keys.status()).toMatchObject({ migrationAvailable: false });
  const unreachable = await fixture('keychain', false);
  await expect(unreachable.keys.getOrCreate()).rejects.toThrow(/no OS keychain/);
  expect(await exists(join(unreachable.root, 'key'))).toBe(false);
});

it('migrates a file key into the keychain and removes the file', async () => {
  const f = await fixture();
  const original = Buffer.alloc(32, 9);
  await writeFile(join(f.root, 'key'), original);
  await f.keys.migrate('keychain');
  expect(await exists(join(f.root, 'key'))).toBe(false);
  expect(await f.keys.current()).toEqual(original);
  expect(await f.keys.status()).toMatchObject({ storage: 'keychain', keyId: keyId(original) });
  await f.keys.migrate('keychain');
  expect(await f.keys.current()).toEqual(original);
});

it('keeps the file when the keychain does not return what it was given', async () => {
  const f = await fixture();
  const original = Buffer.alloc(32, 3);
  await writeFile(join(f.root, 'key'), original);
  f.fake.keychain.set = async () => {};
  await expect(f.keys.migrate('keychain')).rejects.toThrow(/did not return/);
  expect(await readFile(join(f.root, 'key'))).toEqual(original);
});

it('migrates back to a file and clears the keychain', async () => {
  const f = await fixture('file');
  await writeFile(join(f.root, 'key'), Buffer.alloc(32, 5));
  await f.keys.migrate('keychain');
  expect(await f.keys.status()).toMatchObject({ storage: 'keychain', migrationAvailable: true });
  await f.keys.migrate('file');
  expect(await readFile(join(f.root, 'key'))).toEqual(Buffer.alloc(32, 5));
  expect(f.fake.items.size).toBe(0);
  expect(await f.keys.status()).toMatchObject({ storage: 'file' });
});

it('never generates a second key when the keychain is locked or the item is gone', async () => {
  const f = await fixture();
  const key = await f.keys.getOrCreate();
  const locked = createKeyStorage(f.root, { keychain: f.fake.keychain });
  f.fake.state.failReads = true;
  f.fake.state.available = false;
  await expect(locked.getOrCreate()).rejects.toThrow(/could not be read/);
  expect(await exists(join(f.root, 'key'))).toBe(false);
  expect(await locked.status()).toMatchObject({ sealed: true, keyId: null });
  f.fake.state.failReads = false;
  expect(await locked.current()).toEqual(key);
  f.fake.items.clear();
  const emptied = createKeyStorage(f.root, { keychain: f.fake.keychain });
  await expect(emptied.current()).rejects.toThrow(/missing/);
});

it('reads the keychain once per process', async () => {
  const f = await fixture();
  await f.keys.getOrCreate();
  const fresh = createKeyStorage(f.root, { keychain: f.fake.keychain });
  f.fake.state.calls = 0;
  await fresh.current();
  await fresh.current();
  expect(f.fake.state.calls).toBe(1);
});

it('round-trips sealed documents through a store backed by the fake keychain', async () => {
  const f = await fixture();
  const store = createStore(join(f.root, 'store'), {
    keys: createKeyStorage(join(f.root, 'store'), { keychain: f.fake.keychain }),
  });
  await store.writeSealed('profiles/p.json', 'p', 'profile', {
    kind: 'profile',
    schemaVersion: 1,
    name: 'n',
    rules: [],
  });
  expect(await exists(join(f.root, 'store', 'key'))).toBe(false);
  expect((await store.readSealed('profiles/p.json', 'profile')).name).toBe('n');
  await store.keys.migrate('file');
  expect((await store.readSealed('profiles/p.json', 'profile')).name).toBe('n');
});

it('keeps fixture stores on files even if a machine has a keychain', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak default ')));
  roots.push(root);
  await mkdir(root, { recursive: true });
  const store = createStore(root);
  const seal = await store.sealer();
  seal({ a: 1 });
  expect(await exists(join(root, 'key'))).toBe(true);
  expect(await store.keyStatus()).toMatchObject({ storage: 'file', migrationAvailable: false });
});
