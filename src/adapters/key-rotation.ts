import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sealedSchema } from '../core/schemas.js';
import type { AuditStore } from './audit-store.js';
import { errorCode, writeAtomic } from './atomic.js';
import { keyId } from './crypto.js';
import { checkDestinationPath, exists } from './files.js';
import type { createStore } from './store.js';
import { createSyncStore } from './sync-store.js';

type Store = ReturnType<typeof createStore>;
type SealedFile = { path: string; plain: Record<string, unknown>; sealed: unknown };

/** Sealed documents anywhere in the store. The audit log reseals itself. */
async function storeDocuments(root: string): Promise<SealedFile[]> {
  const found: SealedFile[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'audit') await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const parsed = await readSealedFile(path);
        if (parsed) found.push(parsed);
      }
    }
  }
  try {
    await walk(root);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return found;
}
async function readSealedFile(path: string): Promise<SealedFile | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || !('sealed' in value)) return undefined;
  const { sealed, ...plain } = value as Record<string, unknown>;
  return { path, plain, sealed };
}

export type RotationResult = {
  keyId: string;
  previousKeyId: string;
  resealed: number;
  /** Workspaces that could not be reached; the old key stays until they are resealed. */
  pending: string[];
};

/**
 * Crash-safe by ordering: everything is checked first, then the new key becomes current while
 * the old one stays available for reading. A crash leaves a readable mix of both, and running
 * this again finishes the job. The old key is only destroyed once nothing depends on it.
 *
 * The caller must hold the dashboard's exclusive operation lock.
 */
export async function rotateStoreKey(store: Store, audit: AuditStore): Promise<RotationResult> {
  const keys = store.keys;
  const records = createSyncStore(store);
  const manifests: string[] = [];
  const pending: string[] = [];
  for (const id of await store.listDirectories('repos')) {
    const repo = await records.readRepo(id);
    for (const workspace of Object.values(repo?.workspaces ?? {})) {
      if (await exists(join(workspace.path, '.repo-cloak', 'manifest.json'))) {
        await checkDestinationPath(workspace.path, '.repo-cloak/manifest.json');
        manifests.push(join(workspace.path, '.repo-cloak', 'manifest.json'));
      } else pending.push(workspace.path);
    }
  }
  const files = await storeDocuments(store.root);
  for (const path of manifests) {
    const file = await readSealedFile(path);
    if (file) files.push(file);
  }
  // Nothing has changed yet, so anything unreadable aborts with the store untouched.
  const open = await store.opener();
  const contents = files.map((file) => ({ ...file, value: open(file.sealed, file.plain) }));
  const health = await audit.verify();
  if (!health.ok)
    throw new Error(
      `The audit log is damaged at line ${health.firstBroken.line}; it cannot be resealed`,
    );

  let previous = await keys.retired();
  const before = await keys.current();
  // A crash can land between saving the old key and installing the new one.
  if (previous && before?.equals(previous)) {
    await keys.finishRotation();
    previous = undefined;
  }
  if (!previous) await keys.beginRotation(randomBytes(32));
  const key = await keys.current();
  const old = previous ?? (await keys.retired());
  if (!key || !old) throw new Error('Key rotation lost track of its keys');
  const newId = keyId(key);

  const seal = await store.sealer();
  let resealed = 0;
  for (const file of contents) {
    if (sealedSchema.parse(file.sealed).keyId === newId) continue;
    const sealed = seal(file.value, file.plain);
    await writeAtomic(file.path, `${JSON.stringify({ ...file.plain, sealed }, null, 2)}\n`);
    resealed += 1;
  }
  resealed += await audit.reseal();
  if (!pending.length) await keys.finishRotation();
  await audit.record({
    op: 'key-rotate',
    outcome: 'ok',
    detail: `Resealed ${resealed} records from ${keyId(old)}${pending.length ? `; ${pending.length} workspaces pending` : ''}`,
  });
  return { keyId: newId, previousKeyId: keyId(old), resealed, pending };
}
