import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { errorCode, writeAtomic } from './atomic.js';
import { getOrCreateKey, keyId, loadKey } from './crypto.js';
import { createKeychain } from './keychain.js';
import type { Keychain } from './keychain.js';

export type KeyStorageSetting = 'auto' | 'keychain' | 'file';
export type KeyLocation = 'file' | 'keychain';
export type KeyStatus = {
  sealed: boolean;
  keyId: string | null;
  storage: KeyLocation | null;
  migrationAvailable: boolean;
  rotationPending: boolean;
  unavailable?: string;
};

export class KeyUnavailableError extends Error {}

/**
 * Decides where the store key lives and hands it out.
 *
 * Where it is, is a fact: `key.ref` marks a key held by the OS keychain, `key` is a key file.
 * The `keyStorage` setting only decides where a new key goes and what migration to offer, so
 * changing a setting can never strand existing data. `key.ref` also stops a keychain that is
 * temporarily unreachable from looking like a new install and generating a second key.
 */
export function createKeyStorage(
  root: string,
  options: {
    keychain?: Keychain | undefined;
    setting?: () => Promise<KeyStorageSetting | undefined>;
  } = {},
) {
  const keychain = options.keychain;
  const filePath = join(root, 'key');
  const retiredPath = join(root, 'key.previous');
  const markerPath = join(root, 'key.ref');
  const id = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const account = `store-${id}`;
  const retiredAccount = `store-${id}-previous`;
  let cached: {
    current?: Buffer | undefined;
    retired?: Buffer | undefined;
    /** Usually there is no retired key; without this every read would spawn a keychain process. */
    retiredRead?: boolean;
  } = {};
  let keychainUsable: Promise<boolean> | undefined;

  const usable = () => (keychainUsable ??= keychain?.available() ?? Promise.resolve(false));
  async function present(path: string) {
    try {
      await readFile(path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }
  async function location(): Promise<KeyLocation | null> {
    if (await present(markerPath)) return 'keychain';
    return (await present(filePath)) ? 'file' : null;
  }
  async function setting(): Promise<KeyStorageSetting> {
    return (await options.setting?.()) ?? 'auto';
  }
  async function fromKeychain(name: string): Promise<Buffer | undefined> {
    if (!keychain) throw new KeyUnavailableError('This build has no OS keychain access');
    try {
      return await keychain.get(name);
    } catch (cause) {
      throw new KeyUnavailableError(
        `The store key is in the ${keychain.label}, which could not be read. Unlock it and try again.`,
        { cause },
      );
    }
  }
  async function readFileKey(path: string): Promise<Buffer | undefined> {
    return loadKey(path).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    });
  }
  async function current(): Promise<Buffer | undefined> {
    const where = await location();
    if (where === null) return undefined;
    if (where === 'file') return readFileKey(filePath);
    cached.current ??= await fromKeychain(account);
    if (!cached.current)
      throw new KeyUnavailableError(`The store key is missing from the ${keychain?.label}.`);
    return cached.current;
  }
  async function retired(): Promise<Buffer | undefined> {
    if ((await location()) === 'file') return readFileKey(retiredPath);
    if ((await location()) === null) return undefined;
    if (!cached.retiredRead) {
      cached.retired = await fromKeychain(retiredAccount);
      cached.retiredRead = true;
    }
    return cached.retired;
  }
  async function locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const release = await lock(root, {
      lockfilePath: join(root, 'key.lock'),
      retries: { retries: 40, minTimeout: 25, maxTimeout: 250 },
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }
  async function writeMarker(key: Buffer) {
    await writeAtomic(
      markerPath,
      `${JSON.stringify({ storage: 'keychain', keyId: keyId(key) })}\n`,
    );
  }
  /** A new key goes to the keychain unless the setting or the machine says otherwise. */
  async function getOrCreate(): Promise<Buffer> {
    const where = await location();
    if (where === 'file') {
      const key = await loadKey(filePath);
      if (process.platform !== 'win32') await chmod(filePath, 0o600);
      return key;
    }
    if (where === 'keychain') {
      const key = await current();
      if (key) return key;
    }
    const wanted = await setting();
    if (wanted === 'keychain' && !(await usable()))
      throw new KeyUnavailableError(
        'Key storage is set to keychain, but no OS keychain is reachable',
      );
    if (wanted === 'file' || !(await usable())) return getOrCreateKey(filePath);
    return locked(async () => {
      const raced = await location();
      if (raced === 'file') return loadKey(filePath);
      if (raced === 'keychain') {
        const key = await current();
        if (key) return key;
      }
      const key = randomBytes(32);
      await keychain?.set(account, key);
      await writeMarker(key);
      cached.current = key;
      return key;
    });
  }
  return {
    current,
    retired,
    getOrCreate,
    async status(): Promise<KeyStatus> {
      const where = await location();
      if (where === null)
        return {
          sealed: false,
          keyId: null,
          storage: null,
          migrationAvailable: false,
          rotationPending: false,
        };
      const wanted = await setting();
      const migrationAvailable =
        where === 'keychain' ? wanted === 'file' : wanted !== 'file' && (await usable());
      try {
        const key = await current();
        return {
          sealed: true,
          keyId: key ? keyId(key) : null,
          storage: where,
          migrationAvailable,
          rotationPending: !!(await retired()),
        };
      } catch (error) {
        return {
          sealed: true,
          keyId: null,
          storage: where,
          migrationAvailable: false,
          rotationPending: false,
          unavailable: error instanceof Error ? error.message : 'Key unavailable',
        };
      }
    },
    /** Step one of a rotation: new writes use `next`, and the old key still opens old data. */
    async beginRotation(next: Buffer) {
      await locked(async () => {
        const previous = await current();
        if (!previous) throw new Error('There is no key to rotate');
        if (await retired()) throw new Error('A key rotation is already in progress');
        if ((await location()) === 'file') {
          await writeAtomic(retiredPath, previous);
          await writeAtomic(filePath, next);
        } else {
          await keychain?.set(retiredAccount, previous);
          await keychain?.set(account, next);
          await writeMarker(next);
        }
        cached = { current: next, retired: previous, retiredRead: true };
      });
    },
    async finishRotation() {
      await locked(async () => {
        if ((await location()) === 'file')
          await unlink(retiredPath).catch((error: unknown) => {
            if (errorCode(error) !== 'ENOENT') throw error;
          });
        else await keychain?.remove(retiredAccount);
        cached.retired = undefined;
        cached.retiredRead = true;
      });
    },
    /** Moves the same key, so nothing needs resealing. Verified before the old copy goes. */
    async migrate(target: KeyLocation) {
      await locked(async () => {
        const where = await location();
        if (where === null) throw new Error('There is no key to migrate');
        if (where === target) return;
        if (await retired()) throw new Error('Finish the key rotation before migrating');
        const key = await current();
        if (!key) throw new KeyUnavailableError('The store key could not be read');
        if (target === 'keychain') {
          if (!keychain || !(await usable()))
            throw new KeyUnavailableError('No OS keychain is reachable');
          await keychain.set(account, key);
          if (!(await keychain.get(account))?.equals(key))
            throw new KeyUnavailableError('The keychain did not return the key it was given');
          await writeMarker(key);
          await unlink(filePath);
          cached.current = key;
        } else {
          await writeAtomic(filePath, key);
          await unlink(markerPath);
          await keychain?.remove(account);
          cached = {};
        }
      });
    },
  };
}
export type KeyStorage = ReturnType<typeof createKeyStorage>;

/** The OS keychain for the real store; a store elsewhere (tests, fixtures) stays on files. */
export function defaultKeyStorage(
  root: string,
  isDefaultRoot: boolean,
  setting: () => Promise<KeyStorageSetting | undefined>,
): KeyStorage {
  return createKeyStorage(
    root,
    isDefaultRoot ? { keychain: createKeychain(root), setting } : { setting },
  );
}
