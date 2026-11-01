import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import pLimit from 'p-limit';
import { isBinaryFileSync } from 'isbinaryfile';
import type { SourceFile } from '../core/pull.js';
import { validateRelativePath } from '../core/paths.js';
import { runGit, runGitBytes, worktrees } from './git.js';
import { OperationError } from './ui-operations.js';

export async function validateBranch(root: string, branch: string): Promise<void> {
  if ((await runGit(root, ['check-ref-format', '--branch', branch])).trim() !== branch)
    throw new Error('Use a literal new branch name');
  const refs = (
    await runGit(root, ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`])
  ).split('\n');
  if (refs.includes(`refs/heads/${branch}`)) throw new Error(`Branch ${branch} already exists`);
}
export async function resolveBase(root: string, ref: string): Promise<string> {
  return (
    await runGit(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
  ).trim();
}

async function commitTree(root: string, commit: string) {
  return new Map(
    (await runGit(root, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit]))
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const tab = entry.indexOf('\t');
        // The size column is padded, and is "-" for a submodule.
        const [mode, type, oid, size] = entry.slice(0, tab).split(/\s+/);
        return [entry.slice(tab + 1), { mode, type, oid, size: Number(size) }] as const;
      }),
  );
}
function hasFileParent(entries: Map<string, unknown>, path: string) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) if (entries.has(parts.slice(0, i).join('/'))) return true;
  return false;
}
function blobFile(path: string, bytes: Buffer, mode: string | undefined): SourceFile {
  const file: SourceFile = {
    path,
    bytes,
    binary: isBinaryFileSync(bytes),
    executable: mode === '100755',
  };
  if (!file.binary) {
    try {
      file.text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      file.binary = true;
    }
  }
  return file;
}

/** Git output is buffered up to this much, so a larger blob could not be read anyway. */
const maxBlobBytes = 64 * 1024 * 1024;

/**
 * A pull's view of a commit: raw blobs, so no configured filter program runs. Nothing resolves a
 * symlink within a tree, so symlinks and submodules are skipped, and a path whose parent is now a
 * file no longer exists in this commit.
 */
export async function readCommitSource(
  root: string,
  commit: string,
  paths: string[],
  concurrency: number,
  maxBytes = maxBlobBytes,
) {
  const entries = await commitTree(root, commit);
  const limit = pLimit(concurrency);
  const warnings: string[] = [];
  const files = await Promise.all(
    paths.map((path) =>
      limit(async (): Promise<SourceFile | undefined> => {
        validateRelativePath(path);
        const missing: SourceFile = { path, binary: false, executable: false };
        const entry = entries.get(path);
        if (!entry || hasFileParent(entries, path)) return missing;
        if (entry.mode === '120000' || entry.mode === '160000' || entry.type !== 'blob') {
          warnings.push(`${path}: skipped ${entry.mode === '160000' ? 'submodule' : 'symlink'}`);
          return undefined;
        }
        if (!entry.oid) throw new Error(`${path}: unreadable commit entry`);
        if (entry.size > maxBytes)
          throw new OperationError('limit', `${path}: exceeds the ${maxBytes} byte limit`);
        const bytes = await runGitBytes(root, ['cat-file', 'blob', entry.oid]);
        return blobFile(path, bytes, entry.mode);
      }),
    ),
  );
  return {
    files: files.filter((file): file is SourceFile => file !== undefined),
    warnings: warnings.sort(),
  };
}

/** Read the commit directly so planning never needs a temporary checkout. */
export async function readCommit(
  root: string,
  commit: string,
  paths: string[],
  concurrency: number,
) {
  const entries = await commitTree(root, commit);
  const limit = pLimit(concurrency);
  const files = await Promise.all(
    paths.map((path) =>
      limit(async (): Promise<SourceFile> => {
        validateRelativePath(path);
        if (hasFileParent(entries, path))
          throw new Error(`${path}: base path has a non-directory parent`);
        const entry = entries.get(path);
        if (!entry) return { path, binary: false, executable: false };
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode ?? '') || !entry.oid)
          throw new Error(`${path}: refusing a symlink, submodule or unsupported base file`);
        const bytes = await runGitBytes(root, ['cat-file', 'blob', entry.oid]);
        return blobFile(path, bytes, entry.mode);
      }),
    ),
  );
  return { files, warnings: [] as string[], paths: [...entries.keys()] };
}

export async function create(
  root: string,
  path: string,
  branch: string,
  base: string,
): Promise<void> {
  const hooks = await mkdtemp(join(tmpdir(), 'cloak-hooks-'));
  try {
    const ref = `refs/heads/${branch}`;
    await runGit(root, ['update-ref', ref, base, '0'.repeat(base.length)]);
    try {
      await runGit(root, [
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'core.autocrlf=false',
        'worktree',
        'add',
        '--',
        path,
        branch,
      ]);
    } catch (error) {
      try {
        const trees = await worktrees(root);
        if (trees.some((tree) => resolve(tree.path) === resolve(path)))
          await remove(root, path, branch, base);
        else if (!trees.some((tree) => tree.branch === branch))
          await runGit(root, ['update-ref', '-d', ref, base]);
        else
          throw new Error('The new branch is now checked out in another worktree', {
            cause: error,
          });
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          `Worktree creation failed and cleanup was incomplete; inspect ${path} and branch ${branch}`,
          { cause: cleanup },
        );
      }
      throw error;
    }
  } finally {
    await rm(hooks, { recursive: true, force: true });
  }
}
export async function remove(
  root: string,
  path: string,
  branch: string,
  base: string,
): Promise<void> {
  await runGit(root, ['worktree', 'remove', '--', path]);
  // A compare-and-delete protects a branch that somebody advanced after creation.
  await runGit(root, ['update-ref', '-d', `refs/heads/${branch}`, base]);
}
