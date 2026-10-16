import { selectPullProfiles } from './pull-profiles.js';
import { sourceForWorkspace } from './pull-source.js';
import { basename, join, resolve } from 'node:path';
import type { SyncServices } from '../adapters/sync-services.js';
import { changedProfiles } from '../core/manifest.js';
import { mergeProfiles } from '../core/merge.js';
import { validateRelativePath } from '../core/paths.js';
import { createReplacer } from '../core/replacer.js';
import { selectFiles } from '../core/selection.js';

export type PullOptions = {
  profiles?: string[];
  files?: string[];
  commits?: string[];
  working?: boolean;
  to?: string;
  worktree?: string;
  yes?: boolean;
  dryRun?: boolean;
  from?: string;
  force?: boolean;
  skipConflicts?: boolean;
  newWorkspace?: boolean;
  includeTracked?: boolean;
  newWorktree?: string;
  base?: string;
  path?: string;
};

export async function preparePull(
  services: SyncServices,
  direction: 'pull' | 'push',
  options: PullOptions,
) {
  services = { ...services, cwd: await services.files.canonicalPath(services.cwd) };
  const currentWorkspace = await services.store.findWorkspace(services.cwd);
  if ((direction === 'push' && currentWorkspace) || (direction === 'pull' && !currentWorkspace))
    throw new Error(
      'Restore is the next implementation step; use push in a source repo or pull in a cloak workspace to extract files',
    );
  if (currentWorkspace && options.to) throw new Error('--to is only valid in a source repository');
  if (!currentWorkspace && options.worktree)
    throw new Error('--worktree is only valid when pulling in a cloak workspace');
  const config = await services.store.readConfig();
  let destination = currentWorkspace
    ? await services.files.canonicalPath(currentWorkspace)
    : undefined;
  let previous = destination ? await services.store.readSnapshot(destination) : undefined;
  const repo = previous
    ? await sourceForWorkspace(services, previous, options)
    : await services.git.repoState(services.cwd);
  if (!destination) {
    const record = await services.store.readRepo(repo.repoId);
    const linked = Object.entries(record?.workspaces ?? {});
    if (options.to) {
      const matches = linked.filter(
        ([id, workspace]) => id === options.to || basename(workspace.path) === options.to,
      );
      if (matches.length > 1)
        throw new Error('Workspace name is ambiguous; use its id or full path');
      destination = await services.files.canonicalPath(
        matches[0]?.[1].path ?? resolve(services.cwd, options.to),
      );
    } else if (!options.newWorkspace) {
      const valid = [];
      for (const [id, workspace] of linked)
        if (await services.files.exists(join(workspace.path, '.repo-cloak', 'manifest.json')))
          valid.push({ id, ...workspace });
      const matches = valid.filter(
        (workspace) =>
          repo.branch !== null &&
          (workspace.target?.branch === repo.branch || workspace.origin?.branch === repo.branch),
      );
      const choices = matches.length ? matches : valid;
      if (choices.length === 1) destination = choices[0]?.path;
      else if (choices.length > 1) {
        if (options.yes || !services.interactive)
          throw new Error('Several workspaces are linked; specify --to <workspace>');
        destination = await services.chooseWorkspace(choices.map((workspace) => workspace.path));
      }
    }
    if (destination) previous = await services.store.readSnapshot(destination);
  }
  if (previous && previous.plain.source.repoId !== repo.repoId)
    throw new Error('Destination workspace belongs to another source repository');
  const profiles = await selectPullProfiles(services, repo, options, previous);
  const workspaceId = previous?.plain.workspaceId ?? services.newId();
  let saveConfig = false;
  if (!destination) {
    let root = config.workspacesRoot;
    if (!root) {
      if (options.yes || options.dryRun || !services.interactive)
        throw new Error('Pass --to <directory> or set workspacesRoot in the config');
      root = resolve(services.cwd, await services.workspacesRoot());
      config.workspacesRoot = root;
      saveConfig = true;
    }
    let name = 'workspace';
    try {
      const original = basename(repo.path);
      const result = createReplacer(mergeProfiles(profiles)).anonymize(original, {
        file: original,
        scope: 'paths',
      });
      if (result.text !== original) {
        validateRelativePath(result.text);
        if (!result.text.includes('/')) name = result.text;
      }
    } catch {
      /* A generic name is safer than leaking an unanonymized repo name. */
    }
    destination = await services.files.canonicalPath(
      join(root, `${name}-${workspaceId.slice(0, 8)}`),
    );
  }
  destination = await services.files.canonicalPath(destination);
  if (
    services.files.isWithin(repo.path, destination) ||
    services.files.isWithin(destination, repo.path)
  )
    throw new Error('Workspace and source repository must be separate directories');
  let ancestor = destination;
  while (!(await services.files.exists(ancestor))) {
    const parent = resolve(ancestor, '..');
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const destinationRepo = await services.git.findRepo(ancestor);
  if (destinationRepo && (!previous || destinationRepo.topLevel !== destination))
    throw new Error('A cloak workspace cannot be created inside another Git repository');
  if (
    !previous &&
    (await services.files.exists(destination)) &&
    (await services.files.listDirectory(destination)).length
  )
    throw new Error('A new workspace destination must be empty');
  const explicit = Boolean(options.files?.length || options.commits?.length || options.working);
  if (!explicit && !previous) throw new Error('Choose files with --files, --commit, or --working');
  const files = await services.files.expandPaths(
    repo.path,
    currentWorkspace ? repo.path : services.cwd,
    options.files ?? [],
    profiles.map((profile) => profile.profile),
  );
  const commits = await Promise.all(
    (options.commits ?? []).map((ref) => services.git.commitFiles(repo.path, ref)),
  );
  const working = options.working ? await services.git.workingFiles(repo.path) : [];
  const selected = services.files.filterPaths(
    selectFiles({ files, commits, working }),
    profiles.map((profile) => profile.profile),
  );
  const recorded = Object.values(previous?.data.files ?? {}).map((file) => file.path);
  const paths = selectFiles({
    files: explicit ? selected : recorded,
    extra: changedProfiles(profiles, previous).length || options.includeTracked ? recorded : [],
  });
  return {
    repo,
    destination,
    previous,
    profiles,
    paths,
    workspaceId,
    config,
    saveConfig,
    selection: {
      files: files.length,
      commits: options.commits?.length ?? 0,
      working: Boolean(options.working),
      extra: 0,
    },
  };
}
export type PullSetup = Awaited<ReturnType<typeof preparePull>>;
