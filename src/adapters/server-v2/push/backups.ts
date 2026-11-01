import { chmod, readFile, readdir, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { hashBytes } from '../../../core/hash.js';
import { validateRelativePath } from '../../../core/paths.js';
import type { Dashboard } from '../../../application/dashboard.js';
import { writeAtomic } from '../../atomic.js';
import {
  canonicalPath,
  checkDestinationPath,
  checkSourceDestination,
  exists,
} from '../../files.js';
import { RequestError } from '../router.js';
import {
  backupDays,
  backupIndexSchema,
  backupRoot,
  commonDirOf,
  dayMs,
  encodeBytes,
  manifestFingerprint,
  openManifest,
  readBytes,
  readPart,
  sealManifestCopy,
  writePart,
} from './backup-parts.js';
import type { BackupIndex, Vault } from './backup-parts.js';
import { forgetPush, noticesFor } from './state.js';

const maxBackups = 20;
const maxBackupBytes = 256 * 1024 * 1024;

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
    // Recovery decides these; an index beside a journal means it stopped just short of removing it.
    if (await exists(join(directory, 'journal.json'))) continue;
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
      const fingerprint = manifestFingerprint(vault, manifestNow);
      // A backup from before sealing recorded the bytes' hash. Finding `before` means an undo
      // was interrupted after it wrote the manifest, so this one is finishing the same job.
      if (
        fingerprint !== index.manifestAfter &&
        fingerprint !== index.manifestBefore &&
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
        // A file already back at `before` was restored by an undo that did not finish.
        if (current !== file.after && (file.before === undefined || current !== file.before))
          throw moved();
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
      noticesFor(dashboard).delete(workspaceId);
      forgetPush(dashboard, workspaceId);
      return { restored: plan.length };
    }),
  );
}
