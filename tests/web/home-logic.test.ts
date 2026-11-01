import { expect, it } from 'vitest';
import type { OverviewWorkspace } from '../../src/web/api/contracts.js';
import {
  defaultBranch,
  historyText,
  lineageNodes,
  needsAction,
  otherWorktrees,
  pullEntries,
  pushEntries,
  relativeTime,
  sectionWorkspaces,
  shortTime,
  statCells,
  workspaceBadges,
} from '../../src/web/screens/home/logic.js';
import type { GroupDetailView, WorkspaceDetailView } from '../../src/web/screens/home/types.js';

function workspace(extra: Partial<OverviewWorkspace> = {}): OverviewWorkspace {
  return {
    id: 'w1',
    repoId: 'r1',
    name: 'acme-api',
    path: '/c/acme-api',
    groupId: null,
    state: 'clean',
    counts: { tracked: 9, modified: 0, added: 0, deleted: 0 },
    sourceMoved: false,
    lineage: {
      repo: { id: 'r1', name: 'api', path: '/src/api' },
      worktree: { path: '/src/api', branch: 'main', sha: 'abcdef1234' },
      cloak: { id: 'w1', name: 'acme-api', path: '/c/acme-api' },
    },
    pendingRequests: 0,
    lastUsedAt: '2026-01-01T00:00:00Z',
    lastPullAt: null,
    ...extra,
  };
}
function detail(extra: Partial<WorkspaceDetailView> = {}): WorkspaceDetailView {
  return {
    workspace: workspace(),
    lastPushAt: null,
    pending: [],
    guards: [],
    requests: [],
    history: [],
    profiles: [],
    sourceMovedFiles: 0,
    worktrees: [{ path: '/src/api', branch: 'main' }],
    main: { branch: 'main', sha: 'abcdef1234' },
    ...extra,
  };
}

it('gives every status a text badge', () => {
  const labels = (extra: Partial<OverviewWorkspace>) =>
    workspaceBadges(workspace(extra)).map((badge) => badge.label);
  expect(labels({})).toEqual(['clean']);
  expect(
    labels({ state: 'to-push', counts: { tracked: 9, modified: 3, added: 1, deleted: 0 } }),
  ).toEqual(['↑4 to push']);
  expect(labels({ state: 'source-moved', sourceMoved: true })).toEqual(['↓ source moved']);
  expect(
    labels({
      state: 'to-push',
      sourceMoved: true,
      counts: { tracked: 9, modified: 1, added: 0, deleted: 0 },
    }),
  ).toEqual(['↑1 to push', '↓ source moved']);
  expect(labels({ state: 'missing' })).toEqual(['folder missing']);
  expect(labels({ pendingRequests: 2 })).toEqual(['clean', '2 waiting']);
});

it('treats only quiet, clean workspaces as not needing action', () => {
  expect(needsAction(workspace())).toBe(false);
  expect(needsAction(workspace({ state: 'to-push' }))).toBe(true);
  expect(needsAction(workspace({ state: 'missing' }))).toBe(true);
  expect(needsAction(workspace({ sourceMoved: true }))).toBe(true);
  expect(needsAction(workspace({ pendingRequests: 1 }))).toBe(true);
});

it('sections workspaces by group records and leaves the rest ungrouped', () => {
  const grouped = workspace({ id: 'a' });
  const moved = workspace({ id: 'b', groupId: 'g2' });
  const loose = workspace({ id: 'c' });
  const orphan = workspace({ id: 'd', groupId: 'gone' });
  const details = [{ id: 'g1', members: [{ workspaceId: 'a' }] }] as unknown as GroupDetailView[];
  const sections = sectionWorkspaces(
    [grouped, moved, loose, orphan],
    [
      { id: 'g1', name: 'claims', workspaceCount: 1 },
      { id: 'g2', name: 'billing', workspaceCount: 1 },
    ],
    details,
  );
  expect(sections.map((section) => [section.name, section.items.map((item) => item.id)])).toEqual([
    ['claims', ['a']],
    ['billing', ['b']],
    ['Ungrouped', ['c', 'd']],
  ]);
  expect(sections[0]?.note).toBe('1 repo');
});

it('words times the way the design does', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  expect(relativeTime(null, now)).toBe('never');
  expect(relativeTime('2026-01-10T11:59:50Z', now)).toBe('just now');
  expect(relativeTime('2026-01-10T11:20:00Z', now)).toBe('40m ago');
  expect(relativeTime('2026-01-10T10:00:00Z', now)).toBe('2h ago');
  expect(relativeTime('2026-01-09T10:00:00Z', now)).toBe('yesterday');
  expect(relativeTime('2026-01-04T10:00:00Z', now)).toBe('6d ago');
  expect(shortTime('2026-01-10T10:00:00Z', now)).toBe('2h');
  expect(shortTime('2026-01-09T10:00:00Z', now)).toBe('1d');
});

it('draws lineage through a worktree only when there is one', () => {
  expect(lineageNodes(detail()).map((node) => node.kind)).toEqual(['main repo', 'cloak']);
  expect(lineageNodes(detail())[0]?.ref).toBe('main@abcdef1');
  const nodes = lineageNodes(
    detail({
      workspace: workspace({
        lineage: {
          repo: { id: 'r1', name: 'api', path: '/src/api' },
          worktree: { path: '/src/api/.worktrees/claims', branch: 'feat/x', sha: '1234567890' },
          cloak: { id: 'w1', name: 'acme-api', path: '/c/acme-api' },
        },
      }),
    }),
  );
  expect(nodes.map((node) => [node.kind, node.ref])).toEqual([
    ['main repo', 'main@abcdef1'],
    ['worktree', 'feat/x@1234567'],
    ['cloak', '9 files'],
  ]);
});

it('fills the seven stat cells', () => {
  const cells = statCells(
    detail({
      sourceMovedFiles: 2,
      lastPushAt: null,
      workspace: workspace({ counts: { tracked: 42, modified: 3, added: 1, deleted: 0 } }),
    }),
  );
  expect(cells.map((cell) => cell.label)).toEqual([
    'Tracked',
    'Modified',
    'Added',
    'Deleted',
    'Source moved',
    'Last pull',
    'Last push',
  ]);
  expect(cells.map((cell) => cell.value).slice(0, 5)).toEqual(['42', '3', '1', '0', '2']);
  expect(cells[3]?.tone).toBe('muted');
  expect(cells[6]).toMatchObject({ value: 'never', tone: 'push' });
  expect(statCells(detail({ workspace: workspace({ sourceMoved: true }) }))[4]?.value).toBe('yes');
});

it('offers the planned targets with the origin worktree first', () => {
  const view = detail({
    worktrees: [
      { path: '/src/api', branch: 'main' },
      { path: '/src/api/.worktrees/a', branch: 'a' },
      { path: '/src/api/.worktrees/b', branch: 'b' },
    ],
  });
  expect(otherWorktrees(view).map((tree) => tree.branch)).toEqual(['a', 'b']);
  const push = pushEntries(view);
  expect(push.map((entry) => entry.label)).toEqual([
    'Worktree it came from',
    'Main repo checkout',
    'Another worktree…',
    'New worktree from main',
  ]);
  expect(push[0]?.target).toEqual({ kind: 'origin' });
  expect(push[2]?.hint).toBe('2 more worktrees found');
  expect(pullEntries(view).map((entry) => entry.label)).toEqual([
    'Worktree it came from',
    'Main repo checkout',
    'Another worktree or commit…',
  ]);
  expect(defaultBranch('acme api!')).toBe('cloak/acme-api-');
  expect(defaultBranch('---')).toBe('cloak/workspace');
});

it('describes audit events without file contents', () => {
  const event = {
    seq: 1,
    at: '2026-01-01T00:00:00Z',
    who: 'me',
    op: 'pull',
    outcome: 'ok',
    workspace: { id: 'w1', name: 'acme' },
    files: [{ path: 'a' }, { path: 'b' }],
    profiles: [],
    keyId: null,
    hash: 'h',
    prevHash: 'p',
  } as const;
  expect(historyText({ ...event, files: [...event.files], profiles: [] })).toBe(
    '2 files pulled into acme',
  );
  expect(
    historyText({
      ...event,
      files: [],
      profiles: [],
      outcome: 'failed',
      detail: 'Operation failed',
    }),
  ).toBe('failed · Operation failed');
});
