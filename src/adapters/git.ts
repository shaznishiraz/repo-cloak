import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { unsafeGitConfigKeys } from '../core/git-config.js';
import { repoId } from '../core/identity.js';

const exec = promisify(execFile);

/**
 * Agents can write to a cloak workspace, including its `.git`. Git reads that config whatever we
 * pass, and some keys run commands, so refuse to run Git there until they are gone. Reading with
 * `--file` runs nothing and does not follow includes; an include is itself refused.
 */
export async function assertSafeWorkspaceGit(root: string): Promise<void> {
  const gitPath = join(root, '.git');
  const info = await lstat(gitPath).catch(() => undefined);
  if (!info) return;
  if (!info.isDirectory())
    throw new Error('Workspace Git metadata must be a real .git directory inside the workspace');
  const configPath = join(gitPath, 'config');
  if (!(await lstat(configPath).catch(() => undefined))) return;
  const { stdout } = await exec('git', ['config', '--file', configPath, '--name-only', '--list'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  const unsafe = unsafeGitConfigKeys(stdout.split(/\r?\n/).filter(Boolean));
  if (unsafe.length)
    throw new Error(
      `Refusing to run Git in this workspace: its .git/config sets ${unsafe.join(', ')}, which is not on repo-cloak's safe list because some Git settings can run commands. Review and remove them, then retry.`,
    );
}
async function isCloakWorkspace(cwd: string) {
  const info = await lstat(join(cwd, '.repo-cloak')).catch(() => undefined);
  return !!info?.isDirectory();
}

export async function resolveRepo(cwd: string) {
  try {
    // Ask for absolute paths: relative --git-common-dir output varies by worktree/cwd.
    const { stdout } = await exec(
      'git',
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
      },
    );
    const [topRaw = '', commonRaw = ''] = stdout.replace(/\r?\n$/, '').split(/\r?\n/);
    const [topLevel, commonDir] = await Promise.all([
      realpath(resolve(cwd, topRaw)),
      realpath(resolve(cwd, commonRaw)),
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
  return (await runGitBytes(cwd, args)).toString('utf8');
}
export async function runGitBytes(cwd: string, args: string[]): Promise<Buffer> {
  if (await isCloakWorkspace(cwd)) await assertSafeWorkspaceGit(cwd);
  const result = await exec('git', args, {
    cwd,
    encoding: 'buffer',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.stdout;
}
export async function repoState(cwd: string) {
  const repo = await resolveRepo(cwd);
  const [branchResult, commitResult] = await Promise.allSettled([
    runGit(repo.topLevel, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGit(repo.topLevel, ['rev-parse', '--verify', '--quiet', 'HEAD']),
  ]);
  let branch: string | null = null;
  if (branchResult.status === 'fulfilled') branch = branchResult.value.trim();
  else {
    const error = branchResult.reason;
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 1) throw error;
  }
  let commit: string | null = null;
  if (commitResult.status === 'fulfilled') commit = commitResult.value.trim();
  else {
    const error = commitResult.reason;
    if (!branch || !error || typeof error !== 'object' || !('code' in error) || error.code !== 1)
      throw error;
  }
  return { repoId: repo.repoId, path: repo.topLevel, commonDir: repo.commonDir, branch, commit };
}
export async function resolveCommit(root: string, ref: string): Promise<string> {
  return (
    await runGit(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
  ).trim();
}
export async function commitFiles(root: string, ref: string): Promise<string[]> {
  const sha = await resolveCommit(root, ref);
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
export async function commitFileStats(root: string, ref: string) {
  const sha = await resolveCommit(root, ref);
  const fields = (
    await runGit(root, [
      'diff-tree',
      '--root',
      '-m',
      '--no-commit-id',
      '--numstat',
      '-r',
      '-z',
      '--no-renames',
      sha,
      '--',
    ])
  ).split('\0');
  const stats = new Map<string, { added: number | null; removed: number | null }>();
  for (const field of fields) {
    const first = field.indexOf('\t');
    const second = field.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const added = field.slice(0, first);
    const removed = field.slice(first + 1, second);
    const path = field.slice(second + 1);
    if (!path || stats.has(path)) continue;
    stats.set(path, {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    });
  }
  return stats;
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

export async function recentCommits(root: string, offset = 0) {
  if (!(await repoState(root)).commit) return [];
  const fields = (
    await runGit(root, ['log', '-20', `--skip=${offset}`, '--format=%H%x00%s%x00'])
  ).split('\0');
  const commits: { id: string; subject: string }[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const id = fields[i]?.trim();
    const subject = fields[i + 1];
    if (id && subject !== undefined) commits.push({ id, subject });
  }
  return commits;
}

/**
 * Bulk commits run no repository hooks: a run holds the group lock and the sync queue with no
 * timeout, and one click should not execute code from every member. Drop this to run them.
 */
const commitConfig = ['-c', `core.hooksPath=${devNull}`, '--literal-pathspecs'];

/** Stage and commit exactly these paths. Whatever else the user has staged stays out. */
export async function commitPaths(root: string, paths: string[], message: string) {
  const warnings: string[] = [];
  if (!paths.length) return { warnings };
  const fields = (text: string) => text.split('\0').filter(Boolean);
  const ignored = new Set(
    fields(
      await runGit(root, [
        ...commitConfig,
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        ...paths,
      ]),
    ),
  );
  const tracked = new Set(
    fields(await runGit(root, [...commitConfig, 'ls-files', '-z', '--', ...paths])),
  );
  const present = async (path: string) =>
    lstat(join(root, path)).then(
      () => true,
      () => false,
    );
  const eligible: string[] = [];
  for (const path of paths)
    if (tracked.has(path) || (!ignored.has(path) && (await present(path)))) eligible.push(path);
  if (ignored.size)
    warnings.push(
      `${ignored.size} ignored file${ignored.size === 1 ? ' was' : 's were'} not staged`,
    );
  if (!eligible.length) return { warnings };
  await runGit(root, [...commitConfig, 'add', '-A', '--', ...eligible]);
  // A retry, or content that already matches HEAD, leaves nothing to commit.
  const changed = await runGit(root, [
    ...commitConfig,
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--',
    ...eligible,
  ]);
  if (!changed) return { warnings };
  await runGit(root, [...commitConfig, 'commit', '--only', '-m', message, '--', ...eligible]);
  return { warnings, commit: (await runGit(root, ['rev-parse', '--short', 'HEAD'])).trim() };
}
