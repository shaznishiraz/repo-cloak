import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { repoId } from '../core/identity.js';

const exec = promisify(execFile);
export async function resolveRepo(cwd: string) {
  try {
    // Ask for absolute paths: relative --git-common-dir output varies by worktree/cwd.
    const gitPath = async (flag: string) => {
      const { stdout } = await exec('git', ['rev-parse', '--path-format=absolute', flag], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      });
      return realpath(resolve(cwd, stdout.replace(/\r?\n$/, '')));
    };
    const [topLevel, commonDir] = await Promise.all([
      gitPath('--show-toplevel'),
      gitPath('--git-common-dir'),
    ]);
    return { topLevel, commonDir, repoId: repoId(commonDir) };
  } catch (cause) {
    throw new Error(`${cwd}: could not resolve git repository (Git must be installed)`, { cause });
  }
}

/** Missing repositories are normal for global profile commands; other failures are errors. */
export async function findRepo(cwd: string) {
  try {
    return await resolveRepo(cwd);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (
      cause &&
      typeof cause === 'object' &&
      'stderr' in cause &&
      String(cause.stderr).includes('not a git repository')
    )
      return undefined;
    throw error;
  }
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await exec('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.stdout;
}
export async function repoState(cwd: string) {
  const repo = await resolveRepo(cwd);
  let branch: string | null = null;
  let commit: string | null = null;
  try {
    branch = (await runGit(repo.topLevel, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 1) throw error;
  }
  try {
    commit = (await runGit(repo.topLevel, ['rev-parse', '--verify', '--quiet', 'HEAD'])).trim();
  } catch (error) {
    if (!branch || !error || typeof error !== 'object' || !('code' in error) || error.code !== 1)
      throw error;
  }
  return { repoId: repo.repoId, path: repo.topLevel, commonDir: repo.commonDir, branch, commit };
}
export async function commitFiles(root: string, ref: string): Promise<string[]> {
  const sha = (
    await runGit(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
  ).trim();
  return (
    await runGit(root, [
      'diff-tree',
      '--root',
      '-m',
      '--no-commit-id',
      '--name-only',
      '-r',
      '-z',
      '--no-renames',
      sha,
      '--',
    ])
  )
    .split('\0')
    .filter(Boolean);
}
export async function workingFiles(root: string): Promise<string[]> {
  const fields = (
    await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  ).split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    paths.push(field.slice(3));
    if (field.slice(0, 2).includes('R') || field.slice(0, 2).includes('C')) {
      const original = fields[++i];
      if (original) paths.push(original);
    }
  }
  return paths;
}
export async function worktrees(root: string) {
  const fields = (await runGit(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
  const trees: { path: string; branch: string | null }[] = [];
  for (const field of fields) {
    if (field.startsWith('worktree ')) trees.push({ path: field.slice(9), branch: null });
    if (field.startsWith('branch refs/heads/')) {
      const tree = trees.at(-1);
      if (tree) tree.branch = field.slice(18);
    }
  }
  return trees;
}

export async function recentCommits(root: string) {
  if (!(await repoState(root)).commit) return [];
  const fields = (await runGit(root, ['log', '-20', '--format=%H%x00%s%x00'])).split('\0');
  const commits: { id: string; subject: string }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const id = fields[i]?.trim();
    const subject = fields[i + 1];
    if (id && subject !== undefined) commits.push({ id, subject });
  }
  return commits;
}
