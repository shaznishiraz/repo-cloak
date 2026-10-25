import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findRepo, runGit } from './git.js';
import { exists } from './files.js';
import { isWithin } from './locations.js';
import { checkDestinationPath } from './files.js';
import { errorCode, writeAtomic } from './atomic.js';

export async function excludeAgentHelpers(root: string, generated: string[]) {
  await checkDestinationPath(root, '.git/info/exclude');
  const path = join(root, '.git/info/exclude');
  let previous: Buffer | undefined;
  try {
    previous = await readFile(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  const text = (previous?.toString('utf8') ?? '').replace(
    /\n?# repo-cloak agent helpers:start\n[\s\S]*?# repo-cloak agent helpers:end\n?/g,
    '\n',
  );
  await writeAtomic(
    path,
    `${text}\n# repo-cloak agent helpers:start\n/.repo-cloak/agent/\n/.codex/\n${generated.map((name) => `/${name}`).join('\n')}\n# repo-cloak agent helpers:end\n`,
  );
  return previous;
}

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
