import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getOrCreateKey, keyId, open, seal } from '../../src/adapters/crypto.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((p) => rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});
async function root() {
  const p = await mkdtemp(join(tmpdir(), 'cloak crypto '));
  roots.push(p);
  return p;
}

describe('key management', () => {
  it('creates a persistent 32-byte key with private POSIX permissions', async () => {
    const path = join(await root(), 'store', 'key');
    const key = await getOrCreateKey(path);
    expect(key.length).toBe(32);
    expect(await readFile(path)).toEqual(key);
    expect(await getOrCreateKey(path)).toEqual(key);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it('publishes one complete key when creators race', async () => {
    const path = join(await root(), 'key');
    const keys = await Promise.all(Array.from({ length: 12 }, () => getOrCreateKey(path)));
    expect(keys.every((k) => k.equals(keys[0] ?? Buffer.alloc(0)))).toBe(true);
  });
  it('refuses a damaged key instead of replacing it', async () => {
    const path = join(await root(), 'key');
    await writeFile(path, 'broken');
    await expect(getOrCreateKey(path)).rejects.toThrow('32 bytes');
    expect(await readFile(path, 'utf8')).toBe('broken');
  });
});

describe('authenticated encryption', () => {
  const key = randomBytes(32);
  const plain = { kind: 'manifest', schemaVersion: 2, files: { '日本語.ts': { size: 8 } } };
  const secret = { source: 'Müller', nested: [null, true, 23], extra: { untouched: 'yes' } };
  it('round-trips JSON exactly and uses fresh nonces', () => {
    const blob = seal(secret, key, plain);
    expect(open(blob, key, plain)).toEqual(secret);
    expect(seal(secret, key, plain).nonce).not.toBe(blob.nonce);
    expect(blob.data).not.toContain('Müller');
  });
  it('authenticates the entire plain part independent of object key order', () => {
    const blob = seal(secret, key, plain);
    expect(open(blob, key, { files: plain.files, schemaVersion: 2, kind: 'manifest' })).toEqual(
      secret,
    );
    expect(() => open(blob, key, { ...plain, schemaVersion: 3 })).toThrow();
    expect(() => open(blob, key, { ...plain, unknown: 'added' })).toThrow();
  });
  it('rejects ciphertext, nonce and algorithm tampering', () => {
    const blob = seal(secret, key, plain);
    const bytes = Buffer.from(blob.data, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() => open({ ...blob, data: bytes.toString('base64') }, key, plain)).toThrow();
    expect(() =>
      open({ ...blob, nonce: randomBytes(12).toString('base64') }, key, plain),
    ).toThrow();
    expect(() => open({ ...blob, alg: 'other' }, key, plain)).toThrow();
    expect(() => open({ ...blob, data: `${blob.data}!` }, key, plain)).toThrow();
    expect(() => open({ ...blob, nonce: `${blob.nonce}!` }, key, plain)).toThrow();
  });
  it('names the required key when another key is supplied', () => {
    const blob = seal(secret, key, plain);
    expect(() => open(blob, randomBytes(32), plain)).toThrow(keyId(key));
  });
});
