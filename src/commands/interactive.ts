import type { SyncServices } from '../adapters/sync-services.js';
import type { SavedProfile } from '../core/profiles.js';
import type { PullOptions } from './pull-setup.js';
import type { RepoState } from '../core/pull.js';
import { mergeProfiles } from '../core/merge.js';
import { createSyncCommand } from './sync.js';
import { listWorkspaces } from './workspaces.js';
import { sourceForWorkspace } from './pull-source.js';
import { resolve } from 'node:path';

export type InteractiveAction = 'extract' | 'restore' | 'status' | 'new' | 'ui' | 'exit';
export type InteractiveIO = {
  services: SyncServices;
  action(side: 'source' | 'workspace', hasWorkspaces: boolean): Promise<InteractiveAction>;
  profiles(
    available: SavedProfile[],
    suggested: string[],
  ): Promise<{ selected: SavedProfile[]; create: boolean }>;
  createProfile(repoId: string): Promise<SavedProfile>;
  selection(repo: RepoState, profiles: SavedProfile[], tracked: string[]): Promise<PullOptions>;
  status(root: string): Promise<unknown>;
  write(text: string): void;
  ui(): Promise<void>;
};

export async function runInteractive(io: InteractiveIO, version: string): Promise<void> {
  const { services } = io;
  if (!services.interactive)
    throw new Error('Interactive mode needs a terminal; use an explicit command');
  const root = await services.store.findWorkspace(services.cwd);
  const repo = root ? undefined : await services.git.repoState(services.cwd);
  if (repo) await services.store.registerRepo(repo);
  const linked = repo ? await listWorkspaces(services) : [];
  const ranked = [...linked].sort((a, b) => {
    const matches = (workspace: typeof a) =>
      repo?.branch !== null && workspace.target?.branch === repo?.branch;
    return Number(matches(b)) - Number(matches(a));
  });
  const action = await io.action(root ? 'workspace' : 'source', ranked.length > 0);
  if (action === 'exit') return;
  if (action === 'ui') {
    await io.ui();
    return;
  }
  let workspace = root;
  if (!workspace && action !== 'new') {
    const paths = ranked.map((workspace) => workspace.path);
    if (!paths.length) throw new Error('No linked workspace found; create one first');
    workspace = paths.length === 1 ? paths[0] : await services.chooseWorkspace(paths);
  }
  if (action === 'status') {
    if (!workspace) throw new Error('No workspace selected');
    io.write(`${JSON.stringify(await io.status(workspace), null, 2)}\n`);
    return;
  }
  const run = createSyncCommand(services, version);
  if (action === 'restore') {
    if (!workspace) throw new Error('No workspace selected');
    const result = await run(root ? 'push' : 'pull', root ? {} : { from: workspace });
    io.write(
      `${result.status}: ${result.writes.length} files to write, ${result.deletes.length} to remove\n`,
    );
    return;
  }
  const previous = workspace ? await services.store.readSnapshot(workspace) : undefined;
  const source = repo ?? (previous ? await sourceForWorkspace(services, previous, {}) : undefined);
  if (!source) throw new Error('Could not locate the source repository');
  let suggested = previous?.data.profiles.map((profile) => profile.id) ?? [];
  let selected: SavedProfile[];
  for (;;) {
    const available = (
      await Promise.all([
        services.profiles.list({ kind: 'repo', repoId: source.repoId }),
        services.profiles.list({ kind: 'global' }),
      ])
    ).flat();
    const choice = await io.profiles(available, suggested);
    selected = choice.selected;
    if (choice.create) {
      selected.push(await io.createProfile(source.repoId));
      suggested = selected.map((profile) => profile.id);
      continue;
    }
    if (!selected.length) throw new Error('Choose at least one profile');
    mergeProfiles(selected);
    break;
  }
  const options = await io.selection(
    source,
    selected,
    Object.values(previous?.data.files ?? {}).map((file) => file.path),
  );
  // The file picker returns repository-relative paths, even when started in a subdirectory.
  if (options.files) options.files = options.files.map((path) => resolve(source.path, path));
  options.profiles = selected.map((profile) => profile.id);
  if (action === 'new') options.newWorkspace = true;
  else if (!root && workspace) options.to = workspace;
  const result = await run(root ? 'pull' : 'push', options);
  io.write(
    `${result.status}: ${result.writes.length} files to write, ${result.deletes.length} to remove\n${result.workspace}\n`,
  );
}
