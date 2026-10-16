import { basename, resolve } from 'node:path';
import type { SyncServices } from '../adapters/sync-services.js';
import { hashBytes, hashJson } from '../core/hash.js';
import { planPush } from '../core/push.js';
import { restorePaths, checkPathCollisions } from '../core/paths.js';
import { createReplacer } from '../core/replacer.js';
import { sourceForWorkspace } from './pull-source.js';
import type { PullOptions } from './pull-setup.js';
import { listWorkspaces } from './workspaces.js';
import type { RepoState } from '../core/pull.js';

export async function runPush(
  services: SyncServices,
  options: PullOptions,
  currentWorkspace?: string,
) {
  if (
    options.to ||
    options.profiles?.length ||
    options.files?.length ||
    options.commits?.length ||
    options.working
  )
    throw new Error('Selection and --to flags apply only when extracting source files');
  if (options.force && options.skipConflicts)
    throw new Error('--force and --skip-conflicts cannot be combined');
  if (currentWorkspace && options.from)
    throw new Error('--from is only valid in a source repository');
  let workspace = currentWorkspace;
  let sourceRepo: RepoState | undefined;
  if (!workspace) {
    if (options.worktree) throw new Error('--worktree is only valid in a cloak workspace');
    sourceRepo = await services.git.repoState(services.cwd);
    const linked = await listWorkspaces(services);
    if (options.from) {
      const matches = linked.filter(
        (item) => item.id === options.from || basename(item.path) === options.from,
      );
      if (matches.length > 1)
        throw new Error('Workspace name is ambiguous; use its id or full path');
      workspace = matches[0]?.path ?? resolve(services.cwd, options.from);
    } else {
      const sourceBranch = sourceRepo.branch;
      const branch = linked.filter(
        (item) =>
          sourceBranch !== null &&
          (item.target?.branch === sourceBranch || item.origin?.branch === sourceBranch),
      );
      const choices = branch.length ? branch : linked;
      if (choices.length === 1) workspace = choices[0]?.path;
      else if (choices.length > 1) {
        if (options.yes || !services.interactive)
          throw new Error('Several workspaces are linked; specify --from <workspace>');
        workspace = await services.chooseWorkspace(choices.map((item) => item.path));
      }
    }
  }
  if (!workspace) throw new Error('No linked workspace found; specify --from <workspace>');
  workspace = await services.files.canonicalPath(workspace);
  const previous = await services.store.readSnapshot(workspace);
  if (!previous) throw new Error('The selected directory is not a repo-cloak workspace');
  if (!sourceRepo && !options.worktree && previous.data.target.branch === null)
    throw new Error('This workspace has no target branch; specify --worktree <path>');
  const repo = sourceRepo ?? (await sourceForWorkspace(services, previous, options));
  if (repo.repoId !== previous.plain.source.repoId)
    throw new Error('Workspace belongs to another source repository');
  if (
    services.files.isWithin(repo.path, workspace) ||
    services.files.isWithin(workspace, repo.path)
  )
    throw new Error('Workspace and source repository must be separate directories');
  if (!options.yes && !options.dryRun && !services.interactive)
    throw new Error('Pass --yes to restore without an interactive terminal, or use --dry-run');
  const config = await services.store.readConfig();
  const concurrency = config.concurrency ?? 16;
  const inventory = await services.files.readWorkspace(workspace, [], concurrency);
  const tracked = Object.keys(previous.plain.files);
  const workspaceBytes = await services.files.readWorkspace(
    workspace,
    [...new Set([...tracked, ...inventory.paths])],
    concurrency,
  );
  const current = await services.files.readSourceFiles(
    workspace,
    Object.keys(workspaceBytes.files),
    concurrency,
  );
  if (current.warnings.length) throw new Error(current.warnings.join('\n'));
  const newPaths = Object.keys(workspaceBytes.files).filter(
    (path) => !Object.hasOwn(previous.plain.files, path),
  );
  const restored = restorePaths(
    newPaths,
    createReplacer(previous.data.rules),
    previous.data.ledger,
  );
  const paths = [
    ...new Set([
      ...Object.values(previous.data.files).map((file) => file.path),
      ...restored.paths.map((path) => path.original),
    ]),
  ];
  // Refuse symlinks even when they would otherwise resolve inside the source.
  for (const path of paths) await services.files.checkSourceDestination(repo.path, path);
  const source = await services.files.readSourceFiles(repo.path, paths, concurrency);
  if (source.warnings.length) throw new Error(source.warnings.join('\n'));
  const plan = planPush(previous, current.files, source.files, options);
  const sourceInventory = await services.files.readWorkspace(repo.path, [], concurrency);
  const outputs = new Set(plan.writes.map((file) => file.path));
  const deleted = new Set(plan.deletes);
  checkPathCollisions(
    [...new Set([...sourceInventory.paths.filter((path) => !deleted.has(path)), ...outputs])].map(
      (path) => ({ original: path, anonymized: path }),
    ),
    false,
  );
  plan.data = {
    ...plan.data,
    source: { ...plan.data.source, path: repo.path, commonDir: repo.commonDir },
    target: { ...plan.data.target, branch: repo.branch },
  };
  let status: 'dry-run' | 'cancelled' | 'written' = options.dryRun ? 'dry-run' : 'written';
  if (!options.dryRun && !options.yes && !(await services.confirmPush(plan))) status = 'cancelled';
  if (status === 'written') {
    const manifest = await services.store.sealManifest(plan);
    await services.writeSource({
      root: repo.path,
      commonDir: repo.commonDir ?? repo.path,
      workspace,
      plan,
      manifest,
      async recheck() {
        const snapshot = await services.store.readSnapshot(workspace);
        if (!snapshot || hashBytes(snapshot.bytes) !== hashBytes(previous.bytes))
          throw new Error('Workspace manifest changed while preparing restore; retry');
        const check = await services.files.readWorkspace(
          workspace,
          [...new Set([...tracked, ...inventory.paths])],
          concurrency,
        );
        if (hashJson(check) !== hashJson(workspaceBytes))
          throw new Error('Workspace files changed while preparing restore; retry');
        for (const path of paths) await services.files.checkSourceDestination(repo.path, path);
        const checkSource = await services.files.readSourceFiles(repo.path, paths, concurrency);
        if (hashJson(checkSource) !== hashJson(source))
          throw new Error('Source files changed while preparing restore; retry');
        const checkInventory = await services.files.readWorkspace(repo.path, [], concurrency);
        if (
          hashJson([...checkInventory.paths].sort()) !== hashJson([...sourceInventory.paths].sort())
        )
          throw new Error('Source paths changed while preparing restore; retry');
        const state = await services.git.repoState(repo.path);
        if (
          state.repoId !== repo.repoId ||
          state.branch !== repo.branch ||
          state.commit !== repo.commit
        )
          throw new Error('Source worktree changed while preparing restore; retry');
      },
      afterSave: () => services.store.record(repo, workspace, plan, manifest, services.now()),
    });
  }
  return {
    status,
    workspace,
    workspaceId: previous.plain.workspaceId,
    writes: plan.writes.map((file) => file.path),
    deletes: plan.deletes,
    replacements: plan.preview.filter((match) => match.status === 'replaced').length,
    skipped: plan.conflicts.length,
    warnings: [
      ...plan.warnings,
      ...plan.conflicts.map((path) => `${path}: skipped source conflict`),
    ],
    profileChanges: [],
  };
}
