import type {
  DiffLine,
  GuardCheck,
  OverviewWorkspace,
  PushFile,
  PushReview,
  PushTarget,
  WorktreeOption,
} from '../../api/contracts.js';

export type TargetOption = { value: string; label: string; short: string; target: PushTarget };

export function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
export function directoryOf(path: string) {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at + 1);
}
function relativeTo(root: string, path: string) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : baseName(path);
}

/** The pulled-from worktree comes first and is the default; duplicates of it are left out. */
export function targetOptions(
  workspace: OverviewWorkspace,
  worktrees: WorktreeOption[],
  created?: string,
): TargetOption[] {
  const repo = workspace.lineage.repo;
  const origin = workspace.lineage.worktree;
  const originPath = origin?.path ?? repo.path;
  const options: TargetOption[] = [
    {
      value: 'origin',
      label: `${originPath === repo.path ? repo.name : relativeTo(repo.path, originPath)}${
        origin?.branch ? ` · ${origin.branch}` : ''
      } (pulled from)`,
      short: baseName(originPath),
      target: { kind: 'origin' },
    },
  ];
  if (originPath !== repo.path)
    options.push({
      value: 'main',
      label: `${repo.name} · main checkout`,
      short: repo.name,
      target: { kind: 'main' },
    });
  for (const tree of worktrees) {
    if (tree.path === originPath || tree.path === repo.path) continue;
    options.push({
      value: `worktree:${tree.path}`,
      label: `${relativeTo(repo.path, tree.path)}${tree.branch ? ` · ${tree.branch}` : ''}`,
      short: baseName(tree.path),
      target: { kind: 'worktree', path: tree.path },
    });
  }
  if (created)
    options.push({
      value: `new:${created}`,
      label: `new worktree · ${created}`,
      short: created,
      target: { kind: 'new-worktree', branch: created },
    });
  options.push({
    value: 'new',
    label: 'new worktree from main…',
    short: 'a new worktree',
    target: { kind: 'origin' },
  });
  options.push({
    value: 'dry-run',
    label: 'dry run · write nothing',
    short: 'nothing',
    target: { kind: 'dry-run' },
  });
  return options;
}

export function flagText(file: PushFile) {
  const merged = file.flags.includes('auto-merge');
  const conflict = file.flags.includes('conflict');
  if (conflict) return { text: '↓ source moved · overlaps', tone: 'blocked' };
  if (merged) return { text: '↓ source moved · auto-merge', tone: 'pull' };
  const stats = `+${file.additions} −${file.deletions}`;
  if (file.flags.includes('new-derived-name'))
    return { text: `${stats} · ! new name derived`, tone: 'push' };
  return { text: `${stats} · clean`, tone: 'muted' };
}
export const statusLetter: Record<PushFile['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
};

export const checkIcon: Record<GuardCheck['state'], string> = {
  ok: '✓',
  info: '↓',
  warning: '!',
  blocked: '×',
};
/** `target`, `merge:*` have their own places on the screen. */
export function listedChecks(review: PushReview) {
  return review.checks.filter((check) => check.id !== 'target' && !check.id.startsWith('merge:'));
}
export function mergeNotes(review: PushReview) {
  return review.checks.filter((check) => check.id.startsWith('merge:'));
}
export function targetNote(review: PushReview) {
  return review.checks.find((check) => check.id === 'target');
}

/** Context and added lines count up by one inside a hunk, so any jump starts the next one. */
export function splitHunks(lines: DiffLine[]): DiffLine[][] {
  const hunks: DiffLine[][] = [];
  let last = -1;
  for (const line of lines) {
    const jumped = line.kind !== 'remove' && last !== -1 && line.line > last + 1;
    if (!hunks.length || jumped) hunks.push([]);
    hunks.at(-1)?.push(line);
    if (line.kind !== 'remove') last = line.line;
  }
  return hunks;
}

export function totals(files: PushFile[]) {
  return files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}
export function count(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}
