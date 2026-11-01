import type {
  AuditEventView,
  OverviewGroup,
  OverviewWorkspace,
  PullTarget,
  PushTarget,
} from '../../api/contracts.js';
import type { BadgeTone } from '../../shell/ui/index.js';
import type { GroupDetailView, WorkspaceDetailView } from '../../api/contracts.js';

export const toPushCount = ({ counts }: Pick<OverviewWorkspace, 'counts'>) =>
  counts.modified + counts.added + counts.deleted;

/** Everything except a clean workspace asks for something from its owner. */
export const needsAction = (workspace: OverviewWorkspace) =>
  workspace.state !== 'clean' || workspace.sourceMoved || workspace.pendingRequests > 0;

/** Status is never colour alone: every badge carries its meaning as text. */
export function workspaceBadges(
  workspace: OverviewWorkspace,
): { tone: BadgeTone; label: string }[] {
  if (workspace.state === 'missing') return [{ tone: 'blocked', label: 'folder missing' }];
  if (workspace.state === 'unreadable') return [{ tone: 'blocked', label: 'unreadable' }];
  const badges: { tone: BadgeTone; label: string }[] = [];
  const count = toPushCount(workspace);
  if (count) badges.push({ tone: 'push', label: `↑${count} to push` });
  if (workspace.sourceMoved) badges.push({ tone: 'pull', label: '↓ source moved' });
  if (!badges.length) badges.push({ tone: 'ok', label: 'clean' });
  if (workspace.pendingRequests)
    badges.push({ tone: 'accent', label: `${workspace.pendingRequests} waiting` });
  return badges;
}
export function workspaceDot(workspace: OverviewWorkspace) {
  if (workspace.state === 'missing' || workspace.state === 'unreadable') return 'blocked';
  if (toPushCount(workspace)) return 'push';
  return workspace.sourceMoved ? 'pull' : 'ok';
}

export type ListSection = {
  id: string | null;
  name: string;
  note: string;
  items: OverviewWorkspace[];
};
/** Group membership lives in the group records; a workspace only knows it after a folder move. */
export function sectionWorkspaces(
  workspaces: OverviewWorkspace[],
  groups: OverviewGroup[],
  details: GroupDetailView[],
): ListSection[] {
  const owner = new Map<string, string>();
  for (const group of details)
    for (const member of group.members) owner.set(member.workspaceId, group.id);
  const groupOf = (workspace: OverviewWorkspace) =>
    owner.get(workspace.id) ?? workspace.groupId ?? null;
  const sections: ListSection[] = groups.map((group) => {
    const items = workspaces.filter((workspace) => groupOf(workspace) === group.id);
    const repos = `${items.length} ${items.length === 1 ? 'repo' : 'repos'}`;
    return {
      id: group.id,
      name: group.name,
      note: items.length > 1 ? `${repos} · bulk sync` : repos,
      items,
    };
  });
  const known = new Set(groups.map((group) => group.id));
  const rest = workspaces.filter((workspace) => {
    const group = groupOf(workspace);
    return !group || !known.has(group);
  });
  if (rest.length) sections.push({ id: null, name: 'Ungrouped', note: '', items: rest });
  return sections;
}

export function relativeTime(at: string | null, now = Date.now()) {
  if (!at) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (Number.isNaN(seconds)) return 'unknown';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86400);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}
/** The compact form of the list column: 2h, 40m, 6d. */
export const shortTime = (at: string | null, now = Date.now()) =>
  relativeTime(at, now).replace(' ago', '').replace('just now', 'now').replace('yesterday', '1d');

export function clockTime(at: string, now = new Date()) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `yesterday ${time}`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function historyText(event: AuditEventView) {
  const count = event.files.length;
  const files = `${count} ${count === 1 ? 'file' : 'files'}`;
  const failed = event.outcome === 'failed' ? 'failed · ' : '';
  const name = event.workspace?.name ?? event.workspace?.id ?? '';
  const text: Partial<Record<AuditEventView['op'], string>> = {
    create: `cloak ${name} created · ${files}`,
    pull: `${files} pulled into ${name}`,
    push: `${files} restored from ${name}`,
    delete: `cloak ${name} deleted`,
    'agent-approve': `agent request approved · ${files}`,
    'agent-deny': 'agent request denied',
  };
  return `${failed}${event.detail ?? text[event.op] ?? event.op}`;
}
export function historyTone(event: AuditEventView) {
  if (event.outcome === 'failed') return 'blocked';
  if (event.op === 'pull') return 'pull';
  if (event.op === 'push') return 'push';
  if (event.op === 'create') return 'accent';
  return 'muted';
}

export function shortSha(sha: string | null | undefined) {
  return sha ? sha.slice(0, 7) : 'no commits';
}
const atRef = (branch: string | null | undefined, sha: string | null | undefined) =>
  `${branch ?? 'detached'}@${shortSha(sha)}`;

export type LineageNode = {
  kind: string;
  name: string;
  ref: string;
  tone: 'muted' | 'pull' | 'accent';
};
/** main repo -> worktree@sha -> cloak; a cloak taken from the main checkout has no middle step. */
export function lineageNodes(detail: WorkspaceDetailView): LineageNode[] {
  const { lineage, counts } = detail.workspace;
  const tree = lineage.worktree;
  const onMain = !tree || tree.path === lineage.repo.path;
  const nodes: LineageNode[] = [
    {
      kind: 'main repo',
      name: lineage.repo.name,
      ref: onMain
        ? atRef(tree?.branch ?? detail.main?.branch, tree?.sha ?? detail.main?.sha)
        : atRef(detail.main?.branch, detail.main?.sha),
      tone: 'muted',
    },
  ];
  if (!onMain)
    nodes.push({
      kind: 'worktree',
      name: tree.path.split('/').slice(-2).join('/'),
      ref: atRef(tree.branch, tree.sha),
      tone: 'pull',
    });
  nodes.push({
    kind: 'cloak',
    name: lineage.cloak.name,
    ref: `${counts.tracked} ${counts.tracked === 1 ? 'file' : 'files'}`,
    tone: 'accent',
  });
  return nodes;
}

export type StatCell = { label: string; value: string; tone: string };
export function statCells(detail: WorkspaceDetailView): StatCell[] {
  const { counts, lastPullAt, sourceMoved } = detail.workspace;
  const tone = (value: number, active: string) => (value ? active : 'muted');
  const moved = detail.sourceMovedFiles;
  return [
    { label: 'Tracked', value: String(counts.tracked), tone: 'text' },
    { label: 'Modified', value: String(counts.modified), tone: tone(counts.modified, 'push') },
    { label: 'Added', value: String(counts.added), tone: tone(counts.added, 'ok') },
    { label: 'Deleted', value: String(counts.deleted), tone: tone(counts.deleted, 'blocked') },
    {
      label: 'Source moved',
      value: moved ? String(moved) : sourceMoved ? 'yes' : '0',
      tone: moved || sourceMoved ? 'pull' : 'muted',
    },
    { label: 'Last pull', value: relativeTime(lastPullAt), tone: 'text' },
    {
      label: 'Last push',
      value: relativeTime(detail.lastPushAt),
      tone: detail.lastPushAt ? 'text' : 'push',
    },
  ];
}

export type TargetEntry<T> = { label: string; hint: string; target?: T; action?: string };
function originHint(detail: WorkspaceDetailView) {
  const tree = detail.workspace.lineage.worktree;
  const isMain = !tree || tree.path === detail.workspace.lineage.repo.path;
  return `${isMain ? 'main checkout' : (tree.path.split('/').pop() ?? tree.path)} · ${tree?.branch ?? 'detached'}`;
}
function mainHint(detail: WorkspaceDetailView) {
  return `${detail.workspace.lineage.repo.name} · ${atRef(detail.main?.branch, detail.main?.sha)}`;
}
/** Linked worktrees other than the one the cloak came from. */
export function otherWorktrees(detail: WorkspaceDetailView) {
  const origin = detail.workspace.lineage.worktree?.path;
  return detail.worktrees.slice(1).filter((tree) => tree.path !== origin);
}
export function pushEntries(detail: WorkspaceDetailView): TargetEntry<PushTarget>[] {
  const others = otherWorktrees(detail).length;
  return [
    { label: 'Worktree it came from', hint: originHint(detail), target: { kind: 'origin' } },
    { label: 'Main repo checkout', hint: mainHint(detail), target: { kind: 'main' } },
    {
      label: 'Another worktree…',
      hint: others === 1 ? '1 more worktree found' : `${others} more worktrees found`,
      action: 'worktree',
    },
    {
      label: 'New worktree from main',
      hint: `git worktree add · cloak/${detail.workspace.name}`,
      action: 'new-worktree',
    },
  ];
}
export function pullEntries(detail: WorkspaceDetailView): TargetEntry<PullTarget>[] {
  return [
    { label: 'Worktree it came from', hint: originHint(detail), target: { kind: 'origin' } },
    { label: 'Main repo checkout', hint: mainHint(detail), target: { kind: 'main' } },
    {
      label: 'Another worktree or commit…',
      hint: 'pick worktree or sha',
      action: 'worktree',
    },
  ];
}

export const defaultBranch = (name: string) =>
  `cloak/${name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '') || 'workspace'}`;
