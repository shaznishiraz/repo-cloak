import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createKeychain } from '../../src/adapters/keychain.js';
import type { KeychainExec } from '../../src/adapters/keychain.js';

const key = Buffer.alloc(32, 0xab);
const hex = key.toString('hex');
const failure = (code: number, stderr = '') => Object.assign(new Error('failed'), { code, stderr });
function fake(handler: (file: string, args: string[], stdin?: string) => string) {
  return vi.fn<KeychainExec>(async (file, args, stdin) => ({ stdout: handler(file, args, stdin) }));
}
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('offers nothing on platforms without a supported keychain', () => {
  expect(
    createKeychain(
      '/root',
      'freebsd',
      fake(() => ''),
    ),
  ).toBeUndefined();
});

it('macOS: passes the key on stdin, never in arguments, and verifies the write', async () => {
  const exec = fake((_file, args) => (args[0] === 'find-generic-password' ? `${hex}\n` : ''));
  const keychain = createKeychain('/root', 'darwin', exec);
  await keychain?.set('store-1', key);
  const [write, readBack] = exec.mock.calls;
  expect(write?.[0]).toBe('security');
  expect(write?.[1]).toEqual(['-i']);
  expect(write?.[2]).toBe(`add-generic-password -U -a store-1 -s repo-cloak -w ${hex}\n`);
  expect(JSON.stringify(exec.mock.calls.map((call) => call[1]))).not.toContain(hex);
  expect(readBack?.[1]).toEqual([
    'find-generic-password',
    '-a',
    'store-1',
    '-s',
    'repo-cloak',
    '-w',
  ]);
  expect(await keychain?.get('store-1')).toEqual(key);
});

it('macOS: treats a silently failed write as an error', async () => {
  const exec = fake(() => '');
  await expect(createKeychain('/root', 'darwin', exec)?.set('store-1', key)).rejects.toThrow();
});

it('macOS: reports a missing item as absent and other failures as errors', async () => {
  const missing = vi.fn<KeychainExec>(async () => {
    throw failure(44);
  });
  const chain = createKeychain('/root', 'darwin', missing);
  expect(await chain?.get('store-1')).toBeUndefined();
  await expect(chain?.remove('store-1')).resolves.toBeUndefined();
  const locked = vi.fn<KeychainExec>(async () => {
    throw failure(51);
  });
  await expect(createKeychain('/root', 'darwin', locked)?.get('store-1')).rejects.toThrow();
  expect(await createKeychain('/root', 'darwin', locked)?.available()).toBe(false);
  await expect(
    createKeychain(
      '/root',
      'darwin',
      fake(() => 'not a key'),
    )?.get('store-1'),
  ).rejects.toThrow(/not a repo-cloak key/);
});

it('rejects account names that could become extra arguments', async () => {
  const exec = fake(() => '');
  const chain = createKeychain('/root', 'darwin', exec);
  await expect(chain?.get('x; rm -rf /')).rejects.toThrow(/Invalid/);
  await expect(chain?.set('-w', key)).rejects.toThrow(/Invalid/);
  expect(exec).not.toHaveBeenCalled();
});

it('Linux: stores via stdin and separates not-found from a missing secret service', async () => {
  const exec = fake((_file, args) => (args[0] === 'lookup' ? hex : ''));
  const chain = createKeychain('/root', 'linux', exec);
  await chain?.set('store-1', key);
  expect(exec.mock.calls[0]).toEqual([
    'secret-tool',
    ['store', '--label=repo-cloak store key', 'service', 'repo-cloak', 'account', 'store-1'],
    hex,
  ]);
  expect(await chain?.get('store-1')).toEqual(key);
  await chain?.remove('store-1');
  expect(exec.mock.lastCall?.[1][0]).toBe('clear');
  expect(await chain?.available()).toBe(true);

  const notFound = vi.fn<KeychainExec>(async () => {
    throw failure(1);
  });
  expect(await createKeychain('/root', 'linux', notFound)?.get('store-1')).toBeUndefined();
  expect(await createKeychain('/root', 'linux', notFound)?.available()).toBe(true);
  const noService = vi.fn<KeychainExec>(async () => {
    throw failure(1, 'Cannot autolaunch D-Bus');
  });
  await expect(createKeychain('/root', 'linux', noService)?.get('store-1')).rejects.toThrow();
  expect(await createKeychain('/root', 'linux', noService)?.available()).toBe(false);
  const absent = vi.fn<KeychainExec>(async () => {
    throw failure(127);
  });
  expect(await createKeychain('/root', 'linux', absent)?.available()).toBe(false);
});

it('Windows: protects with DPAPI through stdin and stores only the encrypted blob', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak dpapi '));
  roots.push(root);
  // A reversible stand-in for DPAPI.
  const exec = fake((_file, args, stdin = '') =>
    args.at(-1)?.includes('::Protect(')
      ? Buffer.from(`sealed:${stdin}`).toString('base64')
      : Buffer.from(stdin, 'base64').toString().replace('sealed:', ''),
  );
  const chain = createKeychain(root, 'win32', exec);
  await chain?.set('store-1', key);
  expect(exec.mock.calls[0]?.[0]).toBe('powershell.exe');
  expect(exec.mock.calls[0]?.[1]).toContain('-NonInteractive');
  expect(JSON.stringify(exec.mock.calls.map((call) => call[1]))).not.toContain(
    key.toString('base64'),
  );
  expect(await readdir(root)).toEqual(['key.store-1.dpapi']);
  expect(await chain?.get('store-1')).toEqual(key);
  expect(await chain?.available()).toBe(true);
  await chain?.remove('store-1');
  await chain?.remove('store-1');
  expect(await chain?.get('store-1')).toBeUndefined();
  const broken = vi.fn<KeychainExec>(async () => {
    throw failure(1);
  });
  expect(await createKeychain(root, 'win32', broken)?.available()).toBe(false);
});
