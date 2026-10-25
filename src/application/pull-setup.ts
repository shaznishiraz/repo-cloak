import { selectPullProfiles } from './pull-profiles.js';
import { sourceForWorkspace } from './pull-source.js';
import { basename, join, resolve } from 'node:path';
import type { SyncServices } from '../adapters/sync-services.js';
import { changedProfiles } from '../core/manifest.js';
import { mergeProfiles } from '../core/merge.js';
import { validateRelativePath } from '../core/paths.js';
import { createReplacer } from '../core/replacer.js';
import { selectFiles } from '../core/selection.js';
import { compilePatterns } from '../core/patterns.js';
import { agentLocalPath } from '../core/agent-guidance.js';

export type SyncOptions = {
  name?: string;
  exactFiles?: boolean;
  workspacesRoot?: string;
  postCreateCommands?: string[];
  saveDefaults?: boolean;
  profiles?: string[];
  files?: string[];
  commits?: string[];
  working?: boolean;
  to?: string;
  worktree?: string;
  force?: boolean;
  skipConflicts?: boolean;
  newWorkspace?: boolean;
  newWorktree?: string;
  base?: string;
  path?: string;
};

export async function preparePull(
  services: SyncServices,
  direction: 'pull' | 'push',
  options: SyncOptions,
) {
  services = { ...services, cwd: await services.files.canonicalPath(services.cwd) };
  const currentWorkspace = await services.store.findWorkspace(services.cwd);
  if ((direction === 'push' && currentWorkspace) || (direction === 'pull' && !currentWorkspace))
    throw new Error(
      'Choose a source repository to create a workspace, or a cloak workspace to refresh',
    );
  if (currentWorkspace && options.to)
    throw new Error('A new destination is only valid when creating from a source repository');
  if (!currentWorkspace && options.worktree)
    throw new Error('Source worktree overrides apply to existing cloak workspaces');
  const config = {
    ...(await services.store.readConfig()),
    ...(options.workspacesRoot ? { workspacesRoot: options.workspacesRoot } : {}),
    ...(options.postCreateCommands ? { postCreateCommands: options.postCreateCommands } : {}),
  };
  let destination = currentWorkspace
    ? await services.files.canonicalPath(currentWorkspace)
    : undefined;
  let previous = destination ? await services.store.readSnapshot(destination) : undefined;
  const repo = previous
    ? await sourceForWorkspace(services, previous, options)
    : await services.git.repoState(services.cwd);
  const repoRecord = await services.store.readRepo(repo.repoId);
  const isRepoExcluded = compilePatterns(repoRecord?.exclude ?? []);
  if (!destination && options.to) {
    destination = await services.files.canonicalPath(resolve(services.cwd, options.to));
    previous = await services.store.readSnapshot(destination);
  }
  if (options.newWorkspace && previous)
    throw new Error('Choose an empty destination for a new workspace');
  if (previous) {
    const files = Object.fromEntries(
      Object.entries(previous.data.files).filter(
        ([, file]) => !isRepoExcluded(file.path) && !agentLocalPath(file.path),
      ),
    );
    previous = {
      ...previous,
      plain: {
        ...previous.plain,
        files: Object.fromEntries(
          Object.entries(previous.plain.files).filter(([path]) => Object.hasOwn(files, path)),
        ),
      },
      data: { ...previous.data, files },
    };
  }
  if (previous && previous.plain.source.repoId !== repo.repoId)
    throw new Error('Destination workspace belongs to another source repository');
  const profiles = await selectPullProfiles(services, repo, options, previous);
  const workspaceId = previous?.plain.workspaceId ?? services.newId();
  const saveConfig = Boolean(options.saveDefaults);
  if (!destination) {
    const root = config.workspacesRoot;
    if (!root) throw new Error('Choose a destination folder for cloak workspaces');
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
    if (options.name) {
      validateRelativePath(options.name);
      if (options.name.includes('/') || options.name.length > 80)
        throw new Error('Workspace name must be one folder name, up to 80 characters');
    }
    destination = await services.files.canonicalPath(
      join(root, options.name || `${name}-${workspaceId.slice(0, 8)}`),
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
  if (!explicit && !previous)
    throw new Error('Select files, commits, or working changes in the dashboard');
  const files = options.exactFiles
    ? (options.files ?? []).map((path) => validateRelativePath(path))
    : await services.files.expandPaths(
        repo.path,
        currentWorkspace ? repo.path : services.cwd,
        options.files ?? [],
        profiles.map((profile) => profile.profile),
        repoRecord?.exclude ?? [],
      );
  if (options.files?.length && files.some(isRepoExcluded))
    throw new Error('Explicit file selection includes a path excluded for this repository');
  const commits = await Promise.all(
    (options.commits ?? []).map((ref) => services.git.commitFiles(repo.path, ref)),
  );
  const working = options.working ? await services.git.workingFiles(repo.path) : [];
  const selected = services.files.filterPaths(
    selectFiles({ files, commits, working }),
    profiles.map((profile) => profile.profile),
    repoRecord?.exclude ?? [],
  );
  const recorded = Object.values(previous?.data.files ?? {})
    .map((file) => file.path)
    .filter((path) => !isRepoExcluded(path));
  const paths = selectFiles({
    files: explicit ? selected : recorded,
    extra: changedProfiles(profiles, previous).length ? recorded : [],
  });
  return {
    repo,
    destination,
    previous,
    profiles,
    paths,
    repoExcludes: repoRecord?.exclude ?? [],
    workspaceId,
    config,
    saveConfig,
    selection: {
      files: files.length,
      commits: options.commits?.length ?? 0,
      working: Boolean(options.working),
      extra: 0,
    },
    ...(options.exactFiles ? { exactSelection: true } : {}),
  };
}
export type PullSetup = Omit<Awaited<ReturnType<typeof preparePull>>, 'repoExcludes'> & {
  repoExcludes?: string[];
};
