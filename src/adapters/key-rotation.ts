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

/** Paths of sealed documents anywhere in the store. The audit log reseals itself. */
async function storeDocuments(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== 'audit') await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(path);
    }
  }
  try {
    await walk(root);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return found;
}
/**
 * Undefined only for a file that is gone or was never sealed. Anything else must stop the
 * rotation: skipping a sealed file would strand it under a key that is about to be destroyed.
 */
async function readSealedFile(path: string): Promise<SealedFile | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new Error(`Key rotation stopped: cannot read ${path}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Key rotation stopped: ${path} is not valid JSON`, { cause: error });
  }
  if (!value || typeof value !== 'object' || !('sealed' in value)) return undefined;
  const { sealed, ...plain } = value as Record<string, unknown>;
  return { path, plain, sealed };
}
/** Everything to reseal right now, and registered workspaces that cannot be reached. */
async function scan(store: Store) {
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
  return { paths: [...(await storeDocuments(store.root)), ...manifests], pending };
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
 * The caller must hold the dashboard's exclusive operation lock, but not every writer takes it:
 * agent requests, profile saves and a second launcher can write at any moment. So each file is
 * re-read immediately before it is resealed, never resealed from an earlier copy, and scanning
 * repeats until a whole pass finds nothing on the old key. The only remaining race is a write
 * landing between that read and its reseal.
 */
export async function rotateStoreKey(store: Store, audit: AuditStore): Promise<RotationResult> {
  const keys = store.keys;
  // Nothing has changed yet, so anything unreadable aborts with the store untouched.
  const preflight = await store.opener();
  for (const path of (await scan(store)).paths) {
    const file = await readSealedFile(path);
    if (file) preflight(file.sealed, file.plain);
  }
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
  const open = await store.opener();
  let resealed = 0;
  let pending: string[] = [];
  for (let pass = 0; pass < 5; pass += 1) {
    const found = await scan(store);
    pending = found.pending;
    let changed = 0;
    for (const path of found.paths) {
      const file = await readSealedFile(path);
      if (!file || sealedSchema.parse(file.sealed).keyId === newId) continue;
      const sealed = seal(open(file.sealed, file.plain), file.plain);
      await writeAtomic(path, `${JSON.stringify({ ...file.plain, sealed }, null, 2)}\n`);
      changed += 1;
    }
    resealed += changed;
    if (!changed) break;
    // Still changing after every pass: keep the old key and let a retry finish the job.
    if (pass === 4) pending = [...pending, 'documents still being written'];
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
