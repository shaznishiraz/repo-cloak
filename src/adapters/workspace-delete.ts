import { lstat, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lock } from 'proper-lockfile';
import { createSyncStore } from './sync-store.js';
import type { createStore } from './store.js';
import { canonicalPath, exists, isWithin } from './files.js';
import { findRepo, worktrees } from './git.js';
import { hashJson } from '../core/hash.js';
import { errorCode } from './atomic.js';

export async function deleteWorkspace(
  store: ReturnType<typeof createStore>,
  repoId: string,
  id: string,
  confirmedPath: string,
) {
  const records = createSyncStore(store);
  const record = await records.readRepo(repoId);
  const entry = record && Object.hasOwn(record.workspaces, id) ? record.workspaces[id] : undefined;
  if (!entry || entry.path !== confirmedPath)
    throw new Error('Workspace registration changed; refresh before deleting');
  const path = entry.path;
  const present = await exists(path);
  if (present && (await lstat(path)).isSymbolicLink())
    throw new Error('Refusing to delete a workspace directory symlink');
  const releaseWorkspace = (await exists(dirname(path)))
    ? await lock(path, { retries: 0, realpath: false })
    : async () => {};
  try {
    const releaseRepo = await lock(join(store.root, 'repos', repoId), { retries: 0 });
    try {
      const current = await records.readRepo(repoId);
      if (!current || current.workspaces[id]?.path !== path || (await exists(path)) !== present)
        throw new Error('Workspace changed; refresh before deleting');
      if (present && (await lstat(path)).isSymbolicLink())
        throw new Error('Refusing to delete a workspace directory symlink');
      const target = await canonicalPath(path);
      if (target !== path) throw new Error('Workspace path changed; refresh before deleting');
      const protectedPaths = [store.root];
      for (const candidate of await store.listDirectories('repos')) {
        const repo = await records.readRepo(candidate);
        if (!repo) continue;
        protectedPaths.push(
          repo.path,
          ...(typeof repo.commonDir === 'string' ? [repo.commonDir] : []),
        );
        if ((await exists(repo.path)) && (await findRepo(repo.path)))
          protectedPaths.push(...(await worktrees(repo.path)).map((tree) => tree.path));
        for (const [workspaceId, workspace] of Object.entries(repo.workspaces))
          if (candidate !== repoId || workspaceId !== id) protectedPaths.push(workspace.path);
      }
      for (const protectedPath of protectedPaths) {
        const canonical = await canonicalPath(protectedPath);
        if (isWithin(target, canonical) || isWithin(canonical, target))
          throw new Error('Refusing to delete a source, private store, or overlapping workspace');
      }
      if (present) {
        const snapshot = await records.readSnapshot(path);
        if (
          !snapshot ||
          snapshot.plain.workspaceId !== id ||
          snapshot.plain.source.repoId !== repoId
        )
          throw new Error('Workspace manifest is missing or belongs to another workspace');
        const git = await findRepo(path);
        if (git && (git.topLevel !== target || !isWithin(target, git.commonDir)))
          throw new Error('Refusing to delete a source Git worktree');
      }
      const retired = join(dirname(path), `.repo-cloak-delete-${randomUUID()}`);
      if (present) await rename(path, retired);
      const workspaces = Object.fromEntries(
        Object.entries(current.workspaces).filter(([key]) => key !== id),
      );
      try {
        await store.writeSealed(`repos/${repoId}/repo.json`, repoId, 'repo', {
          ...current,
          workspaces,
        });
      } catch (error) {
        if (present) await rename(retired, path);
        throw error;
      }
      if (present) {
        try {
          await rm(retired, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
        } catch (cause) {
          throw new Error(`Deletion incomplete. Remaining files: ${retired}`, { cause });
        }
      }
      const backup = `repos/${repoId}/manifests/${hashJson(id).slice(7)}.json`;
      try {
        await store.remove(backup);
      } catch (cause) {
        if (errorCode(cause) !== 'ENOENT')
          throw new Error(
            `Workspace deleted but stored manifest cleanup failed: ${join(store.root, backup)}`,
            { cause },
          );
      }
      return { deleted: id };
    } finally {
      await releaseRepo();
    }
  } finally {
    await releaseWorkspace();
  }
}
