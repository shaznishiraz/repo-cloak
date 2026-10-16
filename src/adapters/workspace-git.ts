import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { findRepo, runGit } from './git.js';
import { exists } from './files.js';
import { isWithin } from './locations.js';

export async function prepareWorkspaceGit(root: string, paths: string[]): Promise<boolean> {
  const repo = await findRepo(root);
  if (repo && (repo.topLevel !== root || !isWithin(root, repo.commonDir)))
    throw new Error('Workspace Git metadata must stay inside the workspace');
  if (!repo) {
    await runGit(root, ['init', '-b', 'cloak']);
    return true;
  }
  const staged = (await runGit(root, ['diff', '--cached', '--name-only', '-z', '--']))
    .split('\0')
    .filter(Boolean);
  if (staged.some((path) => paths.includes(path)))
    throw new Error('Unstage changes to the pull destination files before refreshing');
  return false;
}
export async function commitWorkspace(root: string, paths: string[]): Promise<void> {
  const hooks = join(root, '.git', 'repo-cloak-hooks');
  await mkdir(hooks, { recursive: true });
  const options = [
    '-c',
    `core.hooksPath=${hooks}`,
    '-c',
    'commit.gpgSign=false',
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.safecrlf=false',
    '-c',
    'user.name=repo-cloak',
    '-c',
    'user.email=repo-cloak@localhost',
  ];
  await runGit(root, [...options, 'add', '-A', '--', ...paths]);
  await runGit(root, [
    ...options,
    'commit',
    '--only',
    '--allow-empty',
    '-m',
    'Refresh anonymized files',
    '--',
    ...paths.filter(
      (path) => path === '.repo-cloak/manifest.json' || !path.startsWith('.repo-cloak/'),
    ),
  ]);
}
export async function resetWorkspaceIndex(root: string, paths: string[]): Promise<void> {
  if (await exists(join(root, '.git'))) await runGit(root, ['reset', '-q', '--', ...paths]);
}
