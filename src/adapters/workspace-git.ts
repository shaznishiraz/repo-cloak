import { readFile, rm } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { assertSafeWorkspaceGit, findRepo, runGit } from './git.js';
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
  await assertSafeWorkspaceGit(root);
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
    throw new Error('Unstage changes to the files being synchronized before continuing');
  return false;
}
export async function commitWorkspace(
  root: string,
  paths: string[],
  message = 'Refresh anonymized files',
): Promise<void> {
  // The check also covers a workspace whose `.repo-cloak` folder was removed.
  await assertSafeWorkspaceGit(root);
  const options = [
    '--literal-pathspecs',
    '-c',
    // Never a folder inside `.git`: an agent can write there too.
    `core.hooksPath=${devNull}`,
    '-c',
    'core.fsmonitor=false',
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
  const present = await Promise.all(paths.map((path) => exists(join(root, path))));
  const missing = paths.filter((_, index) => !present[index]);
  const tracked = new Set(
    missing.length
      ? (await runGit(root, ['--literal-pathspecs', 'ls-files', '-z', '--', ...missing]))
          .split('\0')
          .filter(Boolean)
      : [],
  );
  paths = paths.filter((path, index) => present[index] || tracked.has(path));
  await runGit(root, [...options, 'add', '-A', '-f', '--', ...paths]);
  await runGit(root, [
    ...options,
    'commit',
    '--only',
    '--allow-empty',
    '-m',
    message,
    '--',
    ...paths.filter(
      (path) => path === '.repo-cloak/manifest.json' || !path.startsWith('.repo-cloak/'),
    ),
  ]);
}

/** Prepare inside the workspace writer lock; rollback restores unrelated staged bytes exactly. */
export async function prepareWorkspaceCheckpoint(
  root: string,
  paths: string[],
  generated: string[] = [],
  initialPaths = paths,
) {
  const allowed = (path: string) =>
    !generated.includes(path) &&
    !path.toLowerCase().startsWith('.codex/') &&
    (!path.startsWith('.repo-cloak/') || path === '.repo-cloak/manifest.json');
  paths = [...new Set(paths)].filter(allowed);
  const initialized = await prepareWorkspaceGit(root, paths);
  let index: Buffer | undefined;
  let exclude: Buffer | undefined;
  const restore = async (relative: string, bytes: Buffer | undefined) => {
    if (bytes) await writeAtomic(join(root, relative), bytes);
    else await rm(join(root, relative), { force: true });
  };
  const rollback = async () => {
    if (initialized) await rm(join(root, '.git'), { recursive: true, force: true });
    else {
      await restore('.git/index', index);
      await restore('.git/info/exclude', exclude);
    }
  };
  try {
    await checkDestinationPath(root, '.git/index');
    try {
      index = await readFile(join(root, '.git/index'));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    exclude = await excludeAgentHelpers(root, generated);
  } catch (error) {
    // An existing index has not been changed yet. Do not replace it on a read error.
    if (initialized) await rm(join(root, '.git'), { recursive: true, force: true });
    throw error;
  }
  return {
    commit: (message: string) =>
      commitWorkspace(
        root,
        initialized ? [...new Set(initialPaths)].filter(allowed) : paths,
        message,
      ),
    rollback,
  };
}
