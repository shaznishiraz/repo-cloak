import type { SyncServices } from '../adapters/sync-services.js';
import type { RepoState } from '../core/pull.js';
import { join } from 'node:path';

export async function listWorkspaces(services: SyncServices, currentRepo?: RepoState) {
  const repo = currentRepo ?? (await services.git.repoState(services.cwd));
  const record = await services.store.readRepo(repo.repoId);
  const workspaces = [];
  for (const [id, workspace] of Object.entries(record?.workspaces ?? {})) {
    if (await services.files.exists(join(workspace.path, '.repo-cloak', 'manifest.json')))
      workspaces.push({ id, ...workspace });
  }
  return workspaces.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}
