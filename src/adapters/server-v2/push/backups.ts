import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, readdir, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { z } from 'zod';
import { hashBytes, hashJson } from '../../../core/hash.js';
import { validateRelativePath } from '../../../core/paths.js';
import type { Dashboard } from '../../../application/dashboard.js';
import { writeAtomic } from '../../atomic.js';
import {
  canonicalPath,
  checkDestinationPath,
  checkSourceDestination,
  exists,
} from '../../files.js';
import { resolveRepo } from '../../git.js';
import { OperationError } from '../../ui-operations.js';
import { RequestError } from '../router.js';

const dayMs = 24 * 60 * 60 * 1000;
const backupDays = 7;
const maxBackups = 20;
const maxBackupBytes = 256 * 1024 * 1024;
export const backupIdSchema = z.string().uuid();
const backupIndexSchema = z.object({
  id: backupIdSchema,
  workspaceId: z.string().min(1),
  root: z.string().min(1),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** The manifest the push left behind. Undo is refused once anything has moved it on. */
  manifestAfter: z.string(),
  files: z.array(
    z.object({
      path: z.string().min(1),
      blob: z
        .string()
        .regex(/^f\d+$/)
        .nullable(),
      mode: z.number().int().nullable(),
      after: z.string().nullable(),
    }),
  ),
});
export type BackupIndex = z.infer<typeof backupIndexSchema>;
export type Vault = Awaited<ReturnType<Dashboard['sync']['vault']>>;

/* ---------- Sealed parts ---------- */
const partName = /^[a-z]+\d*$/;
const authenticated = (backupId: string, part: string) => ({
  kind: 'push-backup',
  backupId,
  part,
});
/** The shape key rotation reseals. The AAD ties each part to one place in one backup. */
export async function writePart(
  vault: Vault,
  directory: string,
  backupId: string,
  part: string,
  value: unknown,
) {
  if (!partName.test(part)) throw new Error('Invalid backup part');
  const plain = authenticated(backupId, part);
  await writeAtomic(
    join(directory, `${part}.json`),
    JSON.stringify({ ...plain, sealed: vault.seal(value, plain) }),
  );
}
export async function readPart(vault: Vault, directory: string, backupId: string, part: string) {
  if (!partName.test(part)) throw new Error('Invalid backup part');
  const { sealed } = JSON.parse(await readFile(join(directory, `${part}.json`), 'utf8')) as {
    sealed?: unknown;
  };
  return vault.open(sealed, authenticated(backupId, part));
}
const encodeBytes = (bytes: Uint8Array) => ({ data: Buffer.from(bytes).toString('base64') });
const bytesSchema = z.object({ data: z.string() });
export async function readBytes(vault: Vault, directory: string, backupId: string, part: string) {
  const { data } = bytesSchema.parse(await readPart(vault, directory, backupId, part));
  return Buffer.from(data, 'base64');
}
/*
 * A manifest's bytes change with each seal, and key rotation reseals it. So a backup keeps the
 * manifest opened (inside its own seal) and compares what manifests say, not how they are sealed.
 */
function openManifest(vault: Vault, bytes: Uint8Array) {
  const { sealed, ...plain } = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    sealed: unknown;
  };
  return { plain, data: vault.open(sealed, plain) };
}
export function manifestFingerprint(vault: Vault, bytes: Uint8Array) {
  return hashJson(openManifest(vault, bytes));
}
export function sealManifestCopy(vault: Vault, value: unknown) {
  const { plain, data } = manifestCopySchema.parse(value);
  return Buffer.from(`${JSON.stringify({ ...plain, sealed: vault.seal(data, plain) }, null, 2)}\n`);
}
const manifestCopySchema = z.object({ plain: z.looseObject({}), data: z.unknown() });

export async function commonDirOf(dashboard: Dashboard, repoId: string) {
  const main = (await dashboard.sync.worktrees(repoId))[0]?.path;
  if (!main) throw new OperationError('validation', 'The source repository is not available');
  return (await resolveRepo(main)).commonDir;
}
/**
 * Backups hold source bytes, so they live beside the source inside its Git directory: never in the
 * cloak, where an agent could read them, and never committed.
 */
export function backupRoot(commonDir: string, workspaceId: string) {
  return { base: commonDir, relative: `repo-cloak-backups/${hashJson(workspaceId).slice(7, 39)}` };
}
export async function saveBackup(
  vault: Vault,
  commonDir: string,
  workspaceId: string,
  workspace: string,
  root: string,
  paths: string[],
) {
  const id = randomUUID();
  const { base, relative } = backupRoot(commonDir, workspaceId);
  const directory = join(base, relative, id);
  await checkDestinationPath(base, `${relative}/${id}`);
  const entries: { path: string; blob: string | null; mode: number | null }[] = [];
  for (const [index, path] of paths.entries()) {
    await checkSourceDestination(root, path);
    const target = join(root, ...path.split('/'));
    if (await exists(target)) {
      const blob = `f${index}`;
      await writePart(vault, directory, id, blob, encodeBytes(await readFile(target)));
      entries.push({ path, blob, mode: (await lstat(target)).mode & 0o777 });
    } else entries.push({ path, blob: null, mode: null });
  }
  await checkDestinationPath(workspace, '.repo-cloak/manifest.json');
  await writePart(
    vault,
    directory,
    id,
    'manifest',
    openManifest(vault, await readFile(join(workspace, '.repo-cloak', 'manifest.json'))),
  );
  return {
    discard: () => rm(directory, { recursive: true, force: true }),
    /** Written last: a backup without an index was never finished and cannot be undone. */
    async finish() {
      const createdAt = new Date();
      const files = await Promise.all(
        entries.map(async (entry) => {
          const target = join(root, ...entry.path.split('/'));
          return {
            ...entry,
            after: (await exists(target)) ? hashBytes(await readFile(target)) : null,
          };
        }),
      );
      const index: BackupIndex = {
        id,
        workspaceId,
        root,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + backupDays * dayMs).toISOString(),
        manifestAfter: manifestFingerprint(
          vault,
          await readFile(join(workspace, '.repo-cloak', 'manifest.json')),
        ),
        files,
      };
      await writePart(vault, directory, id, 'index', index);
    },
  };
}
/** A plaintext backup from before sealing. Rewriting the index is the commit point. */
async function sealLegacy(vault: Vault, directory: string, index: BackupIndex) {
  for (const file of index.files)
    if (file.blob)
      await writePart(
        vault,
        directory,
        index.id,
        file.blob,
        encodeBytes(await readFile(join(directory, file.blob))),
      );
  await writePart(
    vault,
    directory,
    index.id,
    'manifest',
    openManifest(vault, await readFile(join(directory, 'manifest'))),
  );
  await writePart(vault, directory, index.id, 'index', index);
}
async function readIndex(vault: Vault, directory: string, name: string) {
  const raw = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')) as object;
  if ('sealed' in raw) {
    const index = backupIndexSchema.parse(await readPart(vault, directory, name, 'index'));
    // Only leftovers of a migration are not sealed parts; none of them may stay behind.
    for (const entry of await readdir(directory))
      if (!entry.endsWith('.json')) await rm(join(directory, entry), { force: true });
    return index;
  }
  const legacy = backupIndexSchema.parse(raw);
  await sealLegacy(vault, directory, legacy);
  return readIndex(vault, directory, name);
}
async function sizeOf(directory: string) {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const sizes = await Promise.all(
    entries.map(async (entry) => (await stat(join(directory, entry)).catch(() => undefined))?.size),
  );
  return sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0);
}
/** Other workspaces' keys are not needed here: their directories simply age out. */
async function sweepOthers(commonDir: string, own: string) {
  const root = join(commonDir, 'repo-cloak-backups');
  for (const group of await readdir(root).catch(() => [] as string[])) {
    if (group === own) continue;
    const parent = join(root, group);
    for (const name of await readdir(parent).catch(() => [] as string[])) {
      const info = await stat(join(parent, name)).catch(() => undefined);
      if (info && info.mtimeMs + backupDays * dayMs <= Date.now())
        await rm(join(parent, name), { recursive: true, force: true });
    }
    await rmdir(parent).catch(() => {});
  }
}
/** Newest first. Expires, then enforces the count and size bounds, always keeping the newest. */
export async function readBackups(vault: Vault, commonDir: string, workspaceId: string) {
  const { base, relative } = backupRoot(commonDir, workspaceId);
  const parent = join(base, relative);
  const names = await readdir(parent).catch(() => [] as string[]);
  const backups: BackupIndex[] = [];
  for (const name of names) {
    const directory = join(parent, name);
    let index: BackupIndex | undefined;
    try {
      index = await readIndex(vault, directory, name);
    } catch {
      index = undefined;
    }
    // An unfinished or damaged backup is kept for the same window, then removed.
    const age = index
      ? Date.parse(index.expiresAt)
      : (await stat(directory).catch(() => undefined))?.mtimeMs;
    const expired = age === undefined || age + (index ? 0 : backupDays * dayMs) <= Date.now();
    if (expired) await rm(directory, { recursive: true, force: true });
    else if (index?.id === name && index.workspaceId === workspaceId) backups.push(index);
  }
  backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const kept: BackupIndex[] = [];
  let total = 0;
  for (const backup of backups) {
    const directory = join(parent, backup.id);
    total += await sizeOf(directory);
    if (kept.length && (kept.length >= maxBackups || total > maxBackupBytes))
      await rm(directory, { recursive: true, force: true });
    else kept.push(backup);
  }
  await sweepOthers(commonDir, relative.split('/')[1] ?? '');
  return kept;
}
export async function withLocks<T>(workspace: string, commonDir: string, action: () => Promise<T>) {
  const releaseWorkspace = await lock(workspace, { retries: 0 });
  try {
    const releaseSource = await lock(commonDir, { retries: 0 });
    try {
      return await action();
    } finally {
      await releaseSource();
    }
  } finally {
    await releaseWorkspace();
  }
}
export async function undo(
  dashboard: Dashboard,
  repoId: string,
  workspaceId: string,
  backupId: string,
) {
  const { path: workspace } = await dashboard.sync.workspaceTarget(repoId, workspaceId);
  const commonDir = await commonDirOf(dashboard, repoId);
  const vault = await dashboard.sync.vault();
  const index = (await readBackups(vault, commonDir, workspaceId)).find(
    (item) => item.id === backupId,
  );
  if (!index) throw new RequestError(404, 'This backup has expired or was already used');
  const trees = await Promise.all(
    (await dashboard.sync.worktrees(repoId)).map((tree) => canonicalPath(tree.path)),
  );
  if (!trees.includes(await canonicalPath(index.root)))
    throw new RequestError(409, 'The worktree this push went to no longer exists');
  const { base, relative } = backupRoot(commonDir, workspaceId);
  const directory = join(base, relative, backupId);
  return dashboard.sync.operations.exclusive(() =>
    withLocks(workspace, commonDir, async () => {
      const manifestPath = join(workspace, '.repo-cloak', 'manifest.json');
      await checkDestinationPath(workspace, '.repo-cloak/manifest.json');
      const moved = () =>
        new RequestError(
          409,
          'Files changed after this push, so undo would overwrite newer work. Nothing was changed.',
        );
      const manifestNow = await readFile(manifestPath);
      // A backup from before sealing recorded the bytes' hash.
      if (
        manifestFingerprint(vault, manifestNow) !== index.manifestAfter &&
        hashBytes(manifestNow) !== index.manifestAfter
      )
        throw moved();
      const plan: { path: string; target: string; bytes?: Buffer; mode: number | null }[] = [];
      for (const file of index.files) {
        const path = validateRelativePath(file.path);
        await checkSourceDestination(index.root, path);
        const target = join(index.root, ...path.split('/'));
        const present = await exists(target);
        const current = present ? hashBytes(await readFile(target)) : null;
        if (current !== file.after) throw moved();
        plan.push({
          path,
          target,
          mode: file.mode,
          ...(file.blob ? { bytes: await readBytes(vault, directory, backupId, file.blob) } : {}),
        });
      }
      const manifest = sealManifestCopy(
        vault,
        await readPart(vault, directory, backupId, 'manifest'),
      );
      for (const item of plan) {
        if (item.bytes) {
          await writeAtomic(item.target, item.bytes);
          if (item.mode !== null && process.platform !== 'win32')
            await chmod(item.target, item.mode);
        } else await unlink(item.target).catch(() => {});
      }
      await writeAtomic(manifestPath, manifest);
      await rm(directory, { recursive: true, force: true });
      await dashboard.sync.audit.record({
        op: 'push',
        outcome: 'ok',
        workspace: { repoId, id: workspaceId, name: basename(workspace) },
        files: plan.map((item) => ({ path: item.path })),
        detail: 'Undid a push from its backup',
      });
      return { restored: plan.length };
    }),
  );
}
