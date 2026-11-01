import type { LaunchContext, Overview, TreeNode } from '../../api/contracts.js';

export type Target = { repoId: string; worktree: string };

/** Where a new cloak starts: the launch context, unless the user picked somewhere else. */
export function launchTarget(data: Overview | null): Target | null {
  const launch: LaunchContext | undefined = data?.launch;
  if (launch?.kind === 'repo') return { repoId: launch.repoId, worktree: launch.path };
  if (launch?.kind === 'workspace') {
    const workspace = data?.workspaces.find((item) => item.id === launch.workspaceId);
    const worktree = workspace?.lineage.worktree?.path ?? workspace?.lineage.repo.path;
    if (worktree) return { repoId: launch.repoId, worktree };
  }
  const usable = data?.repos.filter((repo) => !repo.missing) ?? [];
  const only = usable.length === 1 ? usable[0] : undefined;
  return only ? { repoId: only.id, worktree: only.path } : null;
}

function isInside(path: string, folder: string) {
  return path.startsWith(`${folder}/`);
}

export type PickState = 'on' | 'partial' | 'off';
/** A node is on when it or a parent folder is picked, partial when something inside it is. */
export function pickState(path: string, paths: ReadonlySet<string>): PickState {
  if (paths.has(path)) return 'on';
  for (const picked of paths) if (isInside(path, picked)) return 'on';
  for (const picked of paths) if (isInside(picked, path)) return 'partial';
  return 'off';
}

/**
 * Toggles one node. Unpicking a file inside a picked folder replaces that folder with the rest
 * of its loaded children, level by level, so the remaining files stay picked.
 */
export function togglePick(
  paths: ReadonlySet<string>,
  node: Pick<TreeNode, 'path'>,
  childrenOf: (folder: string) => TreeNode[] | undefined,
): Set<string> {
  const { path } = node;
  const next = new Set(paths);
  if (pickState(path, paths) !== 'on') {
    for (const picked of paths) if (isInside(picked, path)) next.delete(picked);
    next.add(path);
    return next;
  }
  const parent = [...paths].find((picked) => picked === path || isInside(path, picked));
  if (parent === undefined) return next;
  next.delete(parent);
  let folder = parent;
  while (folder !== path) {
    const children = childrenOf(folder);
    if (!children) return new Set(paths);
    const step = children.find((child) => child.path === path || isInside(path, child.path));
    if (!step) return new Set(paths);
    for (const child of children) if (child !== step && !child.excludedBy) next.add(child.path);
    folder = step.path;
  }
  return next;
}

/** Git dates are ISO; the design shows them relative. */
export function relativeTime(iso: string, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (Number.isNaN(seconds)) return '';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86_400);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function compactCount(value: number) {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(value / 1000)}k`;
}

export function joinFolder(root: string, name: string) {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${name}`;
}
export function lastSegment(path: string) {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/** The server applies the real rule; this only stops an obviously bad name early. */
export function nameProblem(name: string) {
  const value = name.trim();
  if (!value) return 'Give the cloak a name';
  if (value.length > 80) return 'Use 80 characters or fewer';
  if (/[\\/]/.test(value) || value === '.' || value === '..') return 'Use one folder name';
  return undefined;
}
