import { resolve } from 'node:path';
import type { SyncServices } from '../adapters/sync-services.js';
import type { Snapshot } from '../core/manifest.js';
import type { RepoState } from '../core/pull.js';
import type { PullOptions } from './pull-setup.js';

export async function sourceForWorkspace(
  services: SyncServices,
  previous: Snapshot,
  options: PullOptions,
): Promise<RepoState> {
  let path = options.worktree ? resolve(services.cwd, options.worktree) : previous.data.source.path;
  if (!options.worktree) {
    const record = await services.store.readRepo(previous.plain.source.repoId);
    const candidates = [
      record?.path,
      previous.data.source.path,
      previous.data.origin.worktree,
      typeof record?.commonDir === 'string' ? record.commonDir : undefined,
      previous.data.source.commonDir,
    ].filter((path): path is string => Boolean(path));
    const available = [];
    for (const candidate of [...new Set(candidates)])
      if (await services.files.exists(candidate)) available.push(candidate);
    const first = available[0];
    if (!first) throw new Error('The source worktree moved; specify --worktree <path>');
    const trees = await services.git.worktrees(first);
    const branch = previous.data.target.branch ?? previous.data.origin.branch;
    const target = branch ? trees.find((tree) => tree.branch === branch)?.path : first;
    if (!target) throw new Error('The source branch is not checked out; specify --worktree <path>');
    path = target;
  }
  const repo = await services.git.repoState(path);
  if (repo.repoId !== previous.plain.source.repoId)
    throw new Error('The selected worktree belongs to another repository');
  return repo;
}
