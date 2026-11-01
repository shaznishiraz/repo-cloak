import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
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
type BackupIndex = z.infer<typeof backupIndexSchema>;
export async function commonDirOf(dashboard: Dashboard, repoId: string) {
  const main = (await dashboard.sync.worktrees(repoId))[0]?.path;
  if (!main) throw new OperationError('validation', 'The source repository is not available');
  return (await resolveRepo(main)).commonDir;
}
/**
 * Backups hold source bytes, so they live beside the source inside its Git directory: never in the
 * cloak, where an agent could read them, and never committed.
 */
function backupRoot(commonDir: string, workspaceId: string) {
  return { base: commonDir, relative: `repo-cloak-backups/${hashJson(workspaceId).slice(7, 39)}` };
}
export async function saveBackup(
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
      await writeAtomic(join(directory, blob), await readFile(target));
      entries.push({ path, blob, mode: (await lstat(target)).mode & 0o777 });
    } else entries.push({ path, blob: null, mode: null });
  }
  await checkDestinationPath(workspace, '.repo-cloak/manifest.json');
  await writeAtomic(
    join(directory, 'manifest'),
    await readFile(join(workspace, '.repo-cloak', 'manifest.json')),
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
        manifestAfter: hashBytes(await readFile(join(workspace, '.repo-cloak', 'manifest.json'))),
        files,
      };
      await writeAtomic(join(directory, 'index.json'), JSON.stringify(index));
    },
  };
}
export async function readBackups(commonDir: string, workspaceId: string) {
  const { base, relative } = backupRoot(commonDir, workspaceId);
  const parent = join(base, relative);
  const names = await readdir(parent).catch(() => [] as string[]);
  const backups: BackupIndex[] = [];
  for (const name of names) {
    const directory = join(parent, name);
    let index: BackupIndex | undefined;
    try {
      index = backupIndexSchema.parse(
        JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')),
      );
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
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  const index = (await readBackups(commonDir, workspaceId)).find((item) => item.id === backupId);
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
      if (hashBytes(await readFile(manifestPath)) !== index.manifestAfter) throw moved();
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
          ...(file.blob ? { bytes: await readFile(join(directory, file.blob)) } : {}),
        });
      }
      const manifest = await readFile(join(directory, 'manifest'));
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
