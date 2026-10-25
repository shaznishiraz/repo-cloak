import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';
import { runGit } from './git.js';
import { errorCode } from './atomic.js';
import { exists, expandPaths, filterPaths } from './files.js';
import type { Profile } from '../core/rules.js';

/** Fresh path metadata only; Git applies nested, local and global ignore rules. */
export async function listSourcePaths(
  root: string,
  profiles: Profile[] = [],
  respectGitIgnore = true,
  repoExcludes: string[] = [],
): Promise<string[]> {
  if (!respectGitIgnore)
    return [
      ...new Set(
        filterPaths(
          await expandPaths(root, root, ['.'], profiles, repoExcludes),
          profiles,
          repoExcludes,
        ),
      ),
    ].sort();
  const output = await runGit(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--deduplicate',
    '-z',
  ]);
  const paths = filterPaths(
    [...new Set(output.split('\0').filter((path) => path && !path.endsWith('/')))],
    profiles,
    repoExcludes,
  );
  const limit = pLimit(32);
  // Per-request ancestor checks prevent tracked paths inside newly nested repos leaking in.
  const nested = new Map<string, Promise<boolean>>();
  function nestedRepo(directory: string): Promise<boolean> {
    if (directory === '.') return Promise.resolve(false);
    let result = nested.get(directory);
    if (!result) {
      result = (async () =>
        (await exists(join(root, directory, '.git'))) || (await nestedRepo(dirname(directory))))();
      nested.set(directory, result);
    }
    return result;
  }
  const present = await Promise.all(
    paths.map((path) =>
      limit(async () => {
        if (await nestedRepo(dirname(path))) return undefined;
        try {
          const info = await lstat(join(root, path));
          return info.isFile() || info.isSymbolicLink() ? path : undefined;
        } catch (error) {
          if (errorCode(error) === 'ENOENT') return undefined;
          throw error;
        }
      }),
    ),
  );
  return present.filter((path): path is string => path !== undefined).sort();
}
