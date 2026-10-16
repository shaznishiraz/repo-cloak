import { basename, dirname, join, resolve } from 'node:path';
import type { SyncServices } from '../adapters/sync-services.js';
import type { Snapshot } from '../core/manifest.js';
import type { RepoState } from '../core/pull.js';
import type { PullOptions } from './pull-setup.js';
import type { Document } from '../core/schemas.js';
import { isPortableName } from '../core/path-names.js';

export async function prepareNewWorktree(
  services: SyncServices,
  repo: RepoState,
  previous: Snapshot,
  workspace: string,
  options: PullOptions,
  config: Document<'config'>,
) {
  const branch = options.newWorktree ?? '';
  if (!branch) throw new Error('Specify --new-worktree <branch>');
  const baseRef = options.base ?? previous.data.origin.commit;
  if (!baseRef)
    throw new Error('The workspace was extracted before the first commit; specify --base <commit>');
  const base = await services.worktree.resolveBase(repo.path, baseRef);
  const name = `${basename(repo.path)}-${branch.replaceAll('/', '-')}`;
  if (!options.path && !isPortableName(name))
    throw new Error('The default worktree name is not portable; specify --path <directory>');
  const parent = config.worktreePath
    ? resolve(services.cwd, config.worktreePath)
    : dirname(repo.path);
  const path = await services.files.canonicalPath(
    options.path ? resolve(services.cwd, options.path) : join(parent, name),
  );
  async function validate() {
    await services.worktree.validateBranch(repo.path, branch);
    if (await services.files.exists(path))
      throw new Error('A new worktree destination must not exist');
    if (
      [repo.path, workspace, ...(repo.commonDir ? [repo.commonDir] : [])].some(
        (root) => services.files.isWithin(root, path) || services.files.isWithin(path, root),
      )
    )
      throw new Error('A new worktree must be separate from the source and cloak workspace');
    let ancestor = dirname(path);
    while (!(await services.files.exists(ancestor))) ancestor = dirname(ancestor);
    if (await services.git.findRepo(ancestor))
      throw new Error('A new worktree cannot be created inside another Git repository');
    if (await services.store.findWorkspace(ancestor))
      throw new Error('A new worktree cannot be created inside a cloak workspace');
  }
  await validate();
  return { path, branch, base, validate };
}
