import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { profile } from '../fixtures.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((p) => rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cloak store '));
  roots.push(root);
  return { root, store: createStore(root) };
}
describe('store', () => {
  it('round-trips plain config and unknown fields without creating a key', async () => {
    const { root, store } = await fixture();
    const config = {
      kind: 'config',
      schemaVersion: 1,
      concurrency: 16,
      future: { enabled: true },
      extensions: {},
    };
    await store.writePlain('config.json', 'config', config);
    expect(await store.readPlain('config.json', 'config')).toEqual(config);
    expect(await readdir(root)).toEqual(['config.json']);
  });
  it('stores profiles sealed, retaining unknown nested fields across a save', async () => {
    const { root, store } = await fixture();
    const path = 'profiles/pf_test.json';
    const input = { ...profile, future: { enabled: true } };
    await store.writeSealed(path, 'pf_test', 'profile', input);
    const raw = await readFile(join(root, path), 'utf8');
    expect(raw).not.toContain('Acme');
    expect(raw).not.toContain('Northwind');
    expect(JSON.parse(raw)).toMatchObject({ kind: 'profile', schemaVersion: 1, id: 'pf_test' });
    const loaded = await store.readSealed(path, 'profile');
    expect(loaded).toEqual(input);
    await store.writeSealed(path, 'pf_test', 'profile', loaded);
    expect(await store.readSealed(path, 'profile')).toEqual(input);
  });
  it('authenticates envelope metadata and rejects future versions before decrypting', async () => {
    const { root, store } = await fixture();
    const path = 'profiles/pf_test.json';
    await store.writeSealed(path, 'pf_test', 'profile', profile);
    const envelope = JSON.parse(await readFile(join(root, path), 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(join(root, path), JSON.stringify({ ...envelope, id: 'tampered' }));
    await expect(store.readSealed(path, 'profile')).rejects.toThrow(/authenticate/);
    await writeFile(join(root, path), JSON.stringify({ ...envelope, schemaVersion: 99 }));
    await expect(store.readSealed(path, 'profile')).rejects.toThrow(/newer/);
  });
  it('never creates a replacement key when reading sealed files', async () => {
    const { root, store } = await fixture();
    await store.writeSealed('profile.json', 'pf_test', 'profile', profile);
    await rm(join(root, 'key'));
    await expect(store.readSealed('profile.json', 'profile')).rejects.toThrow();
    expect(await readdir(root)).not.toContain('key');
  });
  it('leaves an existing document intact when validation fails', async () => {
    const { root, store } = await fixture();
    await store.writePlain('config.json', 'config', { kind: 'config', schemaVersion: 1 });
    const before = await readFile(join(root, 'config.json'), 'utf8');
    await expect(
      store.writePlain('config.json', 'config', { kind: 'config', schemaVersion: 99 }),
    ).rejects.toThrow();
    expect(await readFile(join(root, 'config.json'), 'utf8')).toBe(before);
    expect(await readdir(root)).toEqual(['config.json']);
  });
  it('serializes concurrent replacements as complete JSON documents', async () => {
    const { root, store } = await fixture();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.writePlain('config.json', 'config', {
          kind: 'config',
          schemaVersion: 1,
          concurrency: i + 1,
        }),
      ),
    );
    expect(await store.readPlain('config.json', 'config')).toHaveProperty('concurrency');
    expect(await readdir(root)).toEqual(['config.json']);
  });
  it.each([
    '../escape.json',
    '/absolute.json',
    'C:\\escape.json',
    'profiles/../../escape',
    'CON.json',
    'a\\..\\escape',
    'file:stream',
  ])('rejects unsafe or nonportable store paths: %s', async (path) => {
    const { store } = await fixture();
    await expect(store.readPlain(path, 'config')).rejects.toThrow(/path/i);
  });
});
