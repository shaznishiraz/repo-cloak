import type { SyncServices } from '../adapters/sync-services.js';
import { estimateRetainedBytes } from '../core/retained-size.js';
import { hashBytes, hashJson } from '../core/hash.js';
import { planPush } from '../core/push.js';
import { restorePaths, checkPathCollisions } from '../core/paths.js';
import { createReplacer } from '../core/replacer.js';
import { sourceForWorkspace } from './pull-source.js';
import type { SyncOptions } from './pull-setup.js';
import { prepareNewWorktree } from './push-worktree.js';
import { compilePatterns } from '../core/patterns.js';

export async function preparePushRun(
  services: SyncServices,
  options: SyncOptions,
  currentWorkspace?: string,
) {
  if ((options.base || options.path) && !options.newWorktree)
    throw new Error('Base and directory overrides require a new branch');
  if (options.newWorktree && options.worktree)
    throw new Error('A new branch and an existing worktree cannot be combined');
  if (options.newWorktree && !currentWorkspace)
    throw new Error('New worktree targets require a cloak workspace');
  if (
    options.to ||
    options.profiles?.length ||
    options.files?.length ||
    options.commits?.length ||
    options.working
  )
    throw new Error(
      'File selection and destinations apply only when creating or refreshing a cloak workspace',
    );
  if (options.force && options.skipConflicts)
    throw new Error('Force and skip-conflict policies cannot be combined');
  if (!currentWorkspace) throw new Error('Select a cloak workspace to restore');
  let workspace = currentWorkspace;
  workspace = await services.files.canonicalPath(workspace);
  const previous = await services.store.readSnapshot(workspace);
  if (!previous) throw new Error('The selected directory is not a repo-cloak workspace');
  if (!options.worktree && !options.newWorktree && previous.data.target.branch === null)
    throw new Error('This workspace has no target branch; choose a source worktree');
  const repo = await sourceForWorkspace(services, previous, options);
  if (repo.repoId !== previous.plain.source.repoId)
    throw new Error('Workspace belongs to another source repository');
  if (
    services.files.isWithin(repo.path, workspace) ||
    services.files.isWithin(workspace, repo.path)
  )
    throw new Error('Workspace and source repository must be separate directories');
  const config = await services.store.readConfig();
  const newTree = options.newWorktree
    ? await prepareNewWorktree(services, repo, previous, workspace, options, config)
    : undefined;
  const target = newTree
    ? { ...repo, path: newTree.path, branch: newTree.branch, commit: newTree.base }
    : repo;
  const concurrency = config.concurrency ?? 16;
  const repoRecord = await services.store.readRepo(repo.repoId);
  const isRepoExcluded = compilePatterns(repoRecord?.exclude ?? []);
  const inventory = await services.files.readWorkspace(workspace, [], concurrency);
  const allowedTracked = Object.entries(previous.data.files).filter(
    ([, file]) => !isRepoExcluded(file.path),
  );
  const tracked = allowedTracked.map(([path]) => path);
  const trackedSet = new Set(tracked);
  const activePrevious = {
    ...previous,
    plain: {
      ...previous.plain,
      files: Object.fromEntries(
        Object.entries(previous.plain.files).filter(([path]) => trackedSet.has(path)),
      ),
    },
    data: { ...previous.data, files: Object.fromEntries(allowedTracked) },
  };
  const untracked = inventory.paths.filter(
    (path) => !Object.hasOwn(activePrevious.plain.files, path),
  );
  const restored = restorePaths(
    untracked,
    createReplacer(previous.data.rules),
    previous.data.ledger,
  );
  const allowedNew = restored.paths.filter((path) => !isRepoExcluded(path.original));
  const workspacePaths = [...new Set([...tracked, ...allowedNew.map((path) => path.anonymized)])];
  const workspaceBytes = await services.files.readWorkspace(workspace, workspacePaths, concurrency);
  const current = await services.files.readSourceFiles(
    workspace,
    Object.keys(workspaceBytes.files),
    concurrency,
  );
  if (current.warnings.length) throw new Error(current.warnings.join('\n'));
  const paths = [
    ...new Set([
      ...allowedTracked.map(([, file]) => file.path),
      ...allowedNew.map((path) => path.original),
    ]),
  ];
  // Refuse symlinks even when they would otherwise resolve inside the source.
  if (!newTree)
    for (const path of paths) await services.files.checkSourceDestination(repo.path, path);
  const commitSource = newTree
    ? await services.worktree.readCommit(repo.path, newTree.base, paths, concurrency)
    : undefined;
  const source =
    commitSource ?? (await services.files.readSourceFiles(repo.path, paths, concurrency));
  if (source.warnings.length) throw new Error(source.warnings.join('\n'));
  const plan = planPush(activePrevious, current.files, source.files, {
    ...options,
    fullSnapshot: Boolean(newTree),
  });
  const sourceInventory = commitSource
    ? { paths: commitSource.paths }
    : await services.files.readWorkspace(repo.path, [], concurrency);
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
    source: { ...plan.data.source, path: target.path, commonDir: target.commonDir },
    target: { ...plan.data.target, branch: target.branch },
  };
  if (newTree) {
    plan.warnings.push(
      `New worktree: ${newTree.path} (${newTree.branch}, base ${newTree.base.slice(0, 12)})`,
    );
    if (previous.data.origin.dirty)
      plan.warnings.push(
        'The full workspace snapshot includes the uncommitted source changes captured during extraction',
      );
  }
  const apply = async () => {
    const manifest = await services.store.sealManifest(plan);
    await services.writeSource({
      root: target.path,
      commonDir: repo.commonDir ?? repo.path,
      workspace,
      plan,
      manifest,
      ...(newTree
        ? {
            prepare: () =>
              services.worktree.create(repo.path, newTree.path, newTree.branch, newTree.base),
            rollback: () =>
              services.worktree.remove(repo.path, newTree.path, newTree.branch, newTree.base),
          }
        : {}),
      async recheck() {
        await services.beforeApply?.();
        const currentRepo = await services.store.readRepo(repo.repoId);
        if (hashJson(currentRepo?.exclude ?? []) !== hashJson(repoRecord?.exclude ?? []))
          throw new Error('Repository exclusions changed while preparing restore; retry');
        const snapshot = await services.store.readSnapshot(workspace);
        if (!snapshot || hashBytes(snapshot.bytes) !== hashBytes(previous.bytes))
          throw new Error('Workspace manifest changed while preparing restore; retry');
        const check = await services.files.readWorkspace(workspace, workspacePaths, concurrency);
        if (hashJson(check) !== hashJson(workspaceBytes))
          throw new Error('Workspace files changed while preparing restore; retry');
        if (newTree) {
          await newTree.validate();
          if ((await services.git.repoState(repo.path)).repoId !== repo.repoId)
            throw new Error('Source repository changed while preparing restore; retry');
          return;
        }
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
      afterSave: () => services.store.record(target, workspace, plan, manifest, services.now()),
    });
  };
  const result = {
    status: 'written' as const,
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
    profileChanges: [] as string[],
  };
  return {
    plan,
    redactions: 0,
    postCreateCommands: [] as string[],
    repository: repo,
    source: { path: workspace, branch: null },
    destination: target,
    bytes: estimateRetainedBytes({ previous, workspaceBytes, current, source, plan }),
    result,
    apply,
  };
}
