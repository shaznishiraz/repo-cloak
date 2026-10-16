import { createHash } from 'node:crypto';

/** The adapter supplies realpath(git common dir), not the worktree root. */
export function repoId(canonicalCommonDir: string): string {
  return createHash('sha256').update(canonicalCommonDir).digest('hex').slice(0, 16);
}
