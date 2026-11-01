import { isPortableName } from '../core/path-names.js';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkVersion, parseDocument, sealedSchema } from '../core/schemas.js';
import type { DocumentKind, Migrations, Sealed } from '../core/schemas.js';
import { errorCode, writeAtomic } from './atomic.js';
import { keyId, open, seal } from './crypto.js';
import { defaultKeyStorage } from './key-storage.js';
import type { KeyStorage, KeyStorageSetting } from './key-storage.js';

const defaultRoot = () => resolve(homedir(), '.repo-cloak');

export function createStore(root = defaultRoot(), injectedKeys?: KeyStorage) {
  root = resolve(root);
  const keys =
    injectedKeys ??
    defaultKeyStorage(
      root,
      root === defaultRoot(),
      async (): Promise<KeyStorageSetting | undefined> => {
        try {
          const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) as {
            keyStorage?: KeyStorageSetting;
          };
          return config.keyStorage;
        } catch {
          return undefined;
        }
      },
    );
  function path(relative: string) {
    // IDs and relative store paths must also be valid on Windows.
    const parts = relative.split('/');
    if (parts.some((part) => !isPortableName(part))) {
      throw new Error(`Invalid store path: ${relative}`);
    }
    return join(root, ...parts);
  }
  async function read(relative: string): Promise<unknown> {
    const file = path(relative);
    try {
      return JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch (cause) {
      throw new Error(`${file}: cannot read JSON document`, { cause });
    }
  }
  /** Encrypts values under the store key, authenticating `plain` alongside each one. */
  async function sealer() {
    const key = await keys.getOrCreate();
    return (value: unknown, plain: unknown = {}): Sealed => seal(value, key, plain);
  }
  /** During a rotation data sealed under the retired key still opens. */
  async function opener() {
    const key = await keys.current();
    if (!key) throw new Error('The store has no encryption key yet');
    const retired = await keys.retired();
    return (sealed: unknown, plain: unknown = {}): unknown =>
      open(
        sealed,
        retired && sealedSchema.parse(sealed).keyId === keyId(retired) ? retired : key,
        plain,
      );
  }
  return {
    root,
    sealer,
    opener,
    keys,
    keyStatus: keys.status,
    async listDirectories(relative: string): Promise<string[]> {
      try {
        return (await readdir(path(relative), { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return [];
        throw error;
      }
    },
    async listFiles(relative: string): Promise<string[]> {
      try {
        const entries = await readdir(path(relative), { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort();
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return [];
        throw error;
      }
    },
    async remove(relative: string): Promise<void> {
      await unlink(path(relative));
    },
    async readPlain<K extends DocumentKind>(
      relative: string,
      kind: K,
      migrations: Migrations = {},
    ) {
      return parseDocument(kind, await read(relative), path(relative), migrations);
    },
    async writePlain<K extends DocumentKind>(relative: string, kind: K, value: unknown) {
      const file = path(relative);
      if (kind !== 'config') throw new Error(`${file}: ${kind} documents must be sealed`);
      const doc = parseDocument(kind, value, file);
      await writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
    },
    async readSealed<K extends 'profile' | 'repo' | 'group' | 'agent'>(
      relative: string,
      kind: K,
      migrations: Migrations = {},
    ) {
      const file = path(relative);
      const envelope = checkVersion(kind, await read(relative), file);
      const { sealed, ...plain } = envelope;
      sealedSchema.parse(sealed);
      const value = (await opener())(sealed, plain);
      const doc = checkVersion(kind, value, file);
      if (doc.schemaVersion !== envelope.schemaVersion)
        throw new Error(`${file}: envelope and document schemaVersion differ`);
      return parseDocument(kind, doc, file, migrations);
    },
    async writeSealed<K extends 'profile' | 'repo' | 'group' | 'agent'>(
      relative: string,
      id: string,
      kind: K,
      value: unknown,
    ) {
      const file = path(relative);
      const doc = parseDocument(kind, value, file);
      const plain = { kind, schemaVersion: doc.schemaVersion, id };
      const sealed = (await sealer())(doc, plain);
      await writeAtomic(file, `${JSON.stringify({ ...plain, sealed }, null, 2)}\n`);
    },
  };
}
