// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Overview, OverviewWorkspace } from '../../src/web/api/contracts.js';
import { startSession } from '../../src/web/shell/load.js';
import { commands } from '../../src/web/shell/commands.js';
import { overview } from '../../src/web/shell/state.js';
import { toasts } from '../../src/web/shell/ui/toast.js';
import { HomeScreen } from '../../src/web/screens/home/index.js';
import type { GroupDetailView, WorkspaceDetailView } from '../../src/web/screens/home/types.js';
import { GroupScreen } from '../../src/web/screens/group/index.js';

const workspaceA: OverviewWorkspace = {
  id: 'w1',
  repoId: 'r1',
  name: 'acme-api',
  path: '/c/acme-api',
  groupId: null,
  state: 'to-push',
  counts: { tracked: 9, modified: 1, added: 0, deleted: 0 },
  sourceMoved: true,
  lineage: {
    repo: { id: 'r1', name: 'api', path: '/src/api' },
    worktree: { path: '/src/api/.worktrees/x', branch: 'feat/x', sha: 'abcdef1234' },
    cloak: { id: 'w1', name: 'acme-api', path: '/c/acme-api' },
  },
  pendingRequests: 1,
  lastUsedAt: '2026-01-02T00:00:00Z',
  lastPullAt: null,
};
const workspaceB: OverviewWorkspace = {
  ...workspaceA,
  id: 'w2',
  repoId: 'r2',
  name: 'acme-web',
  path: '/c/acme-web',
  state: 'clean',
  sourceMoved: false,
  pendingRequests: 0,
  counts: { tracked: 3, modified: 0, added: 0, deleted: 0 },
  lineage: {
    repo: { id: 'r2', name: 'web', path: '/src/web' },
    worktree: { path: '/src/web', branch: 'main', sha: '1234567' },
    cloak: { id: 'w2', name: 'acme-web', path: '/c/acme-web' },
  },
};
const data: Overview = {
  launch: { kind: 'none' },
  repos: [],
  groups: [{ id: 'g1', name: 'claims', workspaceCount: 2 }],
  workspaces: [workspaceA, workspaceB],
  pendingAgentRequests: 1,
  profileCount: 1,
  workspacesRoot: '/c',
};
const detail: WorkspaceDetailView = {
  workspace: workspaceA,
  lastPushAt: null,
  pending: [
    {
      path: 'Northwind.ts',
      restoredPath: 'Acme.ts',
      status: 'modified',
      additions: 4,
      deletions: 2,
    },
  ],
  guards: [
    { id: 'reversal', state: 'ok', title: '3 replaced terms reverse cleanly' },
    { id: 'leaks', state: 'blocked', title: 'Real names found in 1 cloak file', detail: 'a.ts' },
  ],
  requests: [
    {
      id: 'q1',
      repoId: 'r1',
      workspaceId: 'w1',
      workspaceName: 'acme-api',
      path: 'src/One.ts',
      reason: 'Need the interface',
      state: 'waiting',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'q2',
      repoId: 'r1',
      workspaceId: 'w1',
      workspaceName: 'acme-api',
      path: 'src/Db.ts',
      reason: 'Need the context',
      state: 'blocked',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ],
  history: [1, 2, 3, 4].map((seq) => ({
    seq,
    at: '2026-01-01T00:00:00Z',
    who: 'me',
    op: 'pull' as const,
    outcome: 'ok' as const,
    workspace: { id: 'w1', name: 'acme-api' },
    files: [],
    profiles: [],
    keyId: null,
    hash: `h${seq}`,
    prevHash: 'p',
  })),
  profiles: ['sample'],
  sourceMovedFiles: 2,
  worktrees: [
    { path: '/src/api', branch: 'main' },
    { path: '/src/api/.worktrees/x', branch: 'feat/x' },
    { path: '/src/api/.worktrees/y', branch: 'feat/y' },
  ],
  main: { branch: 'main', sha: 'fedcba9876' },
};
const group: GroupDetailView = {
  id: 'g1',
  name: 'claims',
  folder: null,
  revision: 'rev1',
  members: [
    {
      workspaceId: 'w1',
      repoId: 'r1',
      folder: 'acme-api/',
      source: 'api/.worktrees/x',
      target: { kind: 'origin' },
      toPush: 1,
      sourceMoved: 2,
      plan: 'check 2 moved files, then write 1',
      worktree: '/src/api/.worktrees/x',
      tracked: 9,
      worktrees: detail.worktrees,
    },
    {
      workspaceId: 'w2',
      repoId: 'r2',
      folder: 'acme-web/',
      source: 'web',
      target: { kind: 'origin' },
      toPush: 0,
      sourceMoved: 0,
      plan: 'nothing to do',
      worktree: '/src/web',
      tracked: 3,
      worktrees: [{ path: '/src/web', branch: 'main' }],
    },
  ],
  rules: { stopOnGuardFailure: true, sameCommitMessage: true },
  runs: [],
};
const summary = {
  intent: 'restore',
  source: { path: '/c/acme-api', branch: null },
  destination: { path: '/src/api/.worktrees/x', branch: 'feat/x' },
  writes: ['Acme.ts'],
  deletes: [],
  warnings: [],
  conflicts: [],
  profileChanges: [],
  replacements: 1,
  canApply: true,
  forced: false,
  redactions: 0,
  postCreateCommands: [],
};

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let handlers: Record<string, (call: Call) => unknown>;
let root: HTMLElement;
let stop: () => void;

const fakeFetch = ((input: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const path = String(input).split('?')[0] ?? '';
  const call = {
    method,
    path,
    body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
  };
  calls.push(call);
  const handler = handlers[`${method} ${path}`];
  if (!handler)
    return Promise.resolve(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }));
  return Promise.resolve(new Response(JSON.stringify(handler(call) ?? {}), { status: 200 }));
}) as typeof fetch;

async function settle() {
  for (let index = 0; index < 8; index++)
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
}
const named = (name: string) =>
  [...root.querySelectorAll<HTMLElement>('button, a')].find(
    (item) =>
      item.getAttribute('aria-label') === name ||
      item.textContent?.trim() === name ||
      item.textContent?.trim().startsWith(name),
  );
async function click(name: string) {
  const target = name.startsWith('.') ? root.querySelector<HTMLElement>(name) : named(name);
  if (!target) throw new Error(`No control named ${name}: ${root.textContent}`);
  act(() => target.click());
  await settle();
}

beforeEach(() => {
  calls = [];
  toasts.value = [];
  localStorage.clear();
  handlers = {
    'GET /api/v2/overview': () => data,
    'GET /api/v2/session': () => ({ policy: { status: 'none', locked: [] }, store: {} }),
    'GET /api/v2/groups': () => ({ groups: [group] }),
    'GET /api/v2/groups/g1': () => group,
    'GET /api/v2/workspaces/r1/w1': () => detail,
    'GET /api/v2/workspaces/r2/w2': () => ({
      ...detail,
      workspace: workspaceB,
      pending: [],
      requests: [],
      history: [],
    }),
    'GET /api/v2/desktop': () => ({
      folder: { label: 'Reveal in Finder', available: true },
      zed: { label: 'Open in Zed', available: false },
    }),
  };
  stop = startSession({ token: 't', launch: {}, route: '#/' }, fakeFetch);
  overview.value = data;
  root = document.createElement('div');
  document.body.append(root);
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
});
afterEach(() => {
  stop();
  render(null, root);
  root.remove();
  overview.value = null;
});

async function showHome(workspaceId?: string) {
  await act(async () => {
    render(<HomeScreen workspaceId={workspaceId} />, root);
    await Promise.resolve();
  });
  await settle();
}

it('lists workspaces by group with status badges and filters to those needing action', async () => {
  await showHome();
  const rows = () => [...root.querySelectorAll('.ws-row')].map((row) => row.textContent);
  expect(root.querySelector('.ws-section-head')?.textContent).toContain('claims');
  expect(rows()[0]).toContain('↑1 to push');
  expect(rows()[0]).toContain('↓ source moved');
  expect(rows()[1]).toContain('clean');
  await click('Needs action');
  expect(rows()).toHaveLength(1);
  expect(named('Needs action')?.getAttribute('aria-pressed')).toBe('true');
});

it('shows lineage, seven stats, pending, guards, requests and four history rows', async () => {
  await showHome('w1');
  expect([...root.querySelectorAll('.ws-node')].map((node) => node.textContent)).toEqual([
    'main repoapimain@fedcba9',
    'worktree.worktrees/xfeat/x@abcdef1',
    'cloakacme-api9 files',
  ]);
  expect(root.querySelectorAll('.ws-stat')).toHaveLength(7);
  expect(root.querySelector('.ws-change')?.textContent).toContain('Northwind.ts');
  expect(root.querySelector('.ws-change')?.textContent).toContain('→ Acme.ts');
  expect(root.querySelector('.ws-change-counts')?.textContent).toContain('+4');
  expect(root.querySelector('.ws-change-counts')?.textContent).toContain('−2');
  expect(root.querySelector('[data-guard="leaks"]')?.getAttribute('data-state')).toBe('blocked');
  expect(root.querySelectorAll('.ws-history-row')).toHaveLength(4);
  expect(named('Review push →')?.getAttribute('href')).toBe('#/ws/w1/push');
});

it('previews a push on the origin worktree, applies it and refreshes', async () => {
  handlers['POST /api/v2/workspaces/r1/w1/push'] = () => ({
    operationId: 'op1',
    expiresAt: 'x',
    summary,
  });
  handlers['POST /api/v2/operations/op1/apply'] = () => ({
    operationId: 'op1',
    state: 'running',
    expiresAt: 'x',
  });
  handlers['GET /api/v2/operations/op1'] = () => ({
    operationId: 'op1',
    state: 'completed',
    expiresAt: 'x',
    result: { writes: ['Acme.ts'], deletes: [] },
  });
  await showHome('w1');
  await click('.ws-push .btn');
  expect(calls.find((call) => call.path.endsWith('/push'))?.body).toEqual({
    target: { kind: 'origin' },
  });
  expect(root.querySelector('.dialog')?.textContent).toContain('Acme.ts');
  const before = calls.filter((call) => call.path === '/api/v2/workspaces/r1/w1').length;
  await click('Apply');
  await act(async () => {
    await new Promise((done) => setTimeout(done, 300));
  });
  await settle();
  expect(toasts.value.at(-1)?.message).toContain('Push complete');
  expect(calls.filter((call) => call.path === '/api/v2/workspaces/r1/w1').length).toBeGreaterThan(
    before,
  );
  expect(root.querySelector('.dialog')).toBeNull();
});

it('blocks apply on conflicts and links to the push review', async () => {
  handlers['POST /api/v2/workspaces/r1/w1/push'] = () => ({
    operationId: 'op2',
    expiresAt: 'x',
    summary: { ...summary, canApply: false, conflicts: ['Other.ts'], writes: [] },
  });
  await showHome('w1');
  await click('.ws-push .btn');
  expect(named('Apply')).toBeUndefined();
  expect(root.querySelector('.dialog')?.textContent).toContain('Other.ts');
  expect(named('Review push →')?.getAttribute('href')).toBe('#/ws/w1/push');
});

it('requires confirmation when a preview deletes files', async () => {
  handlers['POST /api/v2/workspaces/r1/w1/pull'] = () => ({
    operationId: 'op3',
    expiresAt: 'x',
    summary: { ...summary, intent: 'refresh', deletes: ['Gone.ts'] },
  });
  await showHome('w1');
  await click('.ws-actions .btn');
  expect((named('Apply') as HTMLButtonElement).disabled).toBe(true);
  const box = root.querySelector<HTMLInputElement>('.dialog input[type="checkbox"]');
  act(() => box?.click());
  await settle();
  expect((named('Apply') as HTMLButtonElement).disabled).toBe(false);
});

it('offers every push and pull target and sends the chosen one', async () => {
  handlers['POST /api/v2/workspaces/r1/w1/push'] = ({ body }) => ({
    operationId: 'op4',
    expiresAt: 'x',
    summary: { ...summary, canApply: false },
    patch: (body as { target: { kind: string } }).target.kind === 'patch' ? 'diff --git a b' : '',
  });
  handlers['DELETE /api/v2/operations/op4'] = () => ({});
  await showHome('w1');
  await click('Push target options');
  expect([...root.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
    expect.stringContaining('Worktree it came from'),
    expect.stringContaining('Main repo checkout'),
    expect.stringContaining('Another worktree…'),
    expect.stringContaining('New worktree from main'),
    'Export restored .patch',
    'Dry run — show restored diff only',
  ]);
  await click('Export restored .patch');
  expect(calls.at(-1)?.body).toEqual({ target: { kind: 'patch' } });
  expect(root.querySelector('.op-patch')?.textContent).toBe('diff --git a b');
  expect(named('Download .patch')).toBeDefined();
  await click('Close');

  await click('Pull options');
  expect([...root.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
    expect.stringContaining('Worktree it came from'),
    expect.stringContaining('Main repo checkout'),
    expect.stringContaining('Another worktree or commit…'),
    'Add files / commits to this cloak…',
  ]);
});

it('picks another worktree and a new branch through prompts', async () => {
  handlers['POST /api/v2/workspaces/r1/w1/push'] = () => ({
    operationId: 'op5',
    expiresAt: 'x',
    summary,
  });
  handlers['DELETE /api/v2/operations/op5'] = () => ({});
  await showHome('w1');
  await click('Push target options');
  await click('Another worktree…');
  await click('/src/api/.worktrees/y');
  expect(calls.at(-1)?.body).toEqual({
    target: { kind: 'worktree', path: '/src/api/.worktrees/y' },
  });
  await click('Cancel');
  expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/v2/operations/op5' });
  await click('Push target options');
  await click('New worktree from main');
  await click('Preview');
  expect(calls.filter((call) => call.path.endsWith('/push')).at(-1)?.body).toEqual({
    target: { kind: 'new-worktree', branch: 'cloak/acme-api' },
  });
});

it('approves and denies agent requests inline, and offers a stub for blocked files', async () => {
  handlers['POST /api/v2/requests/w1/q1'] = () => ({});
  handlers['POST /api/v2/requests/w1/q2'] = () => ({});
  await showHome('w1');
  const waiting = root.querySelector('[data-request="q1"]');
  const blocked = root.querySelector('[data-request="q2"]');
  expect(blocked?.textContent).toContain('Blocked');
  expect(blocked?.textContent).not.toContain('Approve');
  act(() => waiting?.querySelector<HTMLButtonElement>('button')?.click());
  await settle();
  expect(calls.find((call) => call.path.endsWith('/q1'))?.body).toEqual({
    decision: 'approve',
    mode: 'full',
  });
  const buttons = root.querySelectorAll<HTMLButtonElement>('[data-request="q2"] button');
  expect([...buttons].map((button) => button.textContent)).toEqual(['Send stub instead', 'Deny']);
  act(() => buttons[1]?.click());
  await settle();
  expect(calls.find((call) => call.path.endsWith('/q2'))?.body).toEqual({ decision: 'deny' });
});

it('shows why a decision failed', async () => {
  await showHome('w1');
  const waiting = root.querySelector('[data-request="q1"]');
  act(() => waiting?.querySelector<HTMLButtonElement>('button')?.click());
  await settle();
  expect(toasts.value.at(-1)).toMatchObject({ tone: 'error', message: 'Not found' });
});

it('disables pull and push for a missing folder but still allows delete', async () => {
  const missing = { ...workspaceA, state: 'missing' as const };
  overview.value = { ...data, workspaces: [missing] };
  handlers['GET /api/v2/workspaces/r1/w1'] = () => ({
    ...detail,
    workspace: missing,
    pending: [],
    guards: [{ id: 'folder', state: 'blocked', title: 'Workspace folder is missing' }],
  });
  handlers['DELETE /api/v2/workspaces/r1/w1'] = () => ({ deleted: 'w1' });
  handlers['GET /api/v2/overview'] = () => ({ ...data, workspaces: [] });
  await showHome('w1');
  expect(root.querySelector('.ws-row')?.textContent).toContain('folder missing');
  expect((root.querySelector('.ws-actions .btn') as HTMLButtonElement).disabled).toBe(true);
  expect((root.querySelector('.ws-push .btn') as HTMLButtonElement).disabled).toBe(true);
  await click('delete');
  await click('Delete cloak');
  expect(calls.find((call) => call.method === 'DELETE')?.body).toEqual({
    path: '/c/acme-api',
    confirm: true,
  });
});

it('walks the commit export from commit to patch', async () => {
  handlers['GET /api/v2/workspaces/r1/w1/export/commits'] = () => [
    { sha: 'a'.repeat(40), subject: 'Add export', when: '', files: 1 },
  ];
  handlers['POST /api/v2/workspaces/r1/w1/export/files'] = () => ({
    files: [
      { index: 0, path: 'Northwind.ts', added: 1, removed: 0, excluded: false },
      { index: 1, path: 'Secret.ts', added: 1, removed: 0, excluded: true },
    ],
  });
  handlers['POST /api/v2/workspaces/r1/w1/export/diff'] = () => ({ patch: 'diff cloaked' });
  await showHome('w1');
  await click('export commit');
  await click('aaaaaaa');
  await click('Build diff');
  expect(calls.at(-1)?.body).toEqual({ commit: 'a'.repeat(40), indexes: [0] });
  expect(root.querySelector('.op-patch')?.textContent).toBe('diff cloaked');
});

it('registers palette actions while a workspace is showing', async () => {
  await showHome('w1');
  expect(commands.value.map((command) => command.title)).toContain('Pull acme-api');
  act(() => render(null, root));
  expect(commands.value.map((command) => command.title)).not.toContain('Pull acme-api');
});

it('offers a first cloak when there are no workspaces', async () => {
  overview.value = { ...data, groups: [], workspaces: [] };
  await showHome();
  expect(root.textContent).toContain('No cloaked workspaces yet');
  expect(named('+ Cloak a repository')?.getAttribute('href')).toBe('#/new');
});

async function showGroup() {
  await act(async () => {
    render(<GroupScreen groupId="g1" />, root);
    await Promise.resolve();
  });
  await settle();
}
const batch = (state: string, memberState = 'completed') => ({
  operationId: 'b1',
  state,
  expiresAt: 'x',
  members: [
    { repoId: 'r1', state: memberState },
    { repoId: 'r2', state: memberState },
  ],
});

it('shows members with target and plan, the folder and the bulk rules', async () => {
  await showGroup();
  const rows = root.querySelectorAll('.grp-row:not(.grp-row-head)');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('push → same worktree');
  expect(rows[0]?.textContent).toContain('↑1');
  expect(rows[0]?.textContent).toContain('↓2');
  expect(rows[0]?.textContent).toContain('check 2 moved files, then write 1');
  expect(rows[1]?.textContent).toContain('nothing to do');
  expect(root.textContent).toContain('No shared folder yet');
  expect(root.textContent).toContain('Stop all if any guard check fails');
  expect(root.textContent).toContain('Same commit message across repos');
  expect(named('↑ Push all')?.textContent).toContain('1 file');
});

it('draws the shared folder tree when the group has one', async () => {
  handlers['GET /api/v2/groups/g1'] = () => ({ ...group, folder: '/c/claims' });
  await showGroup();
  const tree = root.querySelector('.grp-tree')?.textContent;
  expect(tree).toContain('/c/claims/');
  expect(tree).toContain('AGENTS.md');
  expect(tree).toContain('acme-api/');
  expect(tree).toContain('9 files');
  expect(tree).toContain('.repo-cloak/');
});

it('runs a bulk push with the commit message and rules, then follows it', async () => {
  handlers['POST /api/v2/groups/g1/bulk'] = () => ({ operationId: 'b1', expiresAt: 'x', summary });
  handlers['POST /api/v2/group-operations/b1/apply'] = () => batch('running', 'running');
  handlers['GET /api/v2/group-operations/b1'] = () => batch('completed');
  await showGroup();
  await click('↑ Push all');
  const input = root.querySelector<HTMLInputElement>('.dialog input[type="text"]');
  if (!input) throw new Error('No message field');
  act(() => {
    input.value = 'Export claims';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Preview');
  expect(calls.find((call) => call.path.endsWith('/bulk'))?.body).toEqual({
    direction: 'push',
    revision: 'rev1',
    stopOnGuardFailure: true,
    commitMessage: 'Export claims',
  });
  await click('Apply');
  await act(async () => {
    await new Promise((done) => setTimeout(done, 350));
  });
  await settle();
  expect(toasts.value.at(-1)?.message).toContain('Push complete for claims');
});

it('sends the stop rule and only the checked members', async () => {
  handlers['POST /api/v2/groups/g1/bulk'] = () => ({ operationId: 'b1', expiresAt: 'x', summary });
  handlers['DELETE /api/v2/group-operations/b1'] = () => batch('cancelled', 'pending');
  await showGroup();
  const stopRule = [...root.querySelectorAll('label')].find((label) =>
    label.textContent?.includes('Stop all'),
  );
  act(() => stopRule?.querySelector('input')?.click());
  await settle();
  const include = root.querySelector<HTMLInputElement>(
    '[aria-label="Include acme-web/ in bulk action"]',
  );
  act(() => include?.click());
  await settle();
  await click('↓ Pull all');
  expect(calls.find((call) => call.path.endsWith('/bulk'))?.body).toEqual({
    direction: 'pull',
    revision: 'rev1',
    stopOnGuardFailure: false,
    members: ['r1'],
  });
  await click('Cancel');
  expect(calls.at(-1)?.path).toBe('/api/v2/group-operations/b1');
  expect(JSON.parse(localStorage.getItem('cloak-group-rules-g1') ?? '{}')).toMatchObject({
    stopOnGuardFailure: false,
  });
});

it('refuses to run when a guard failed and the stop rule is on', async () => {
  handlers['POST /api/v2/groups/g1/bulk'] = () => ({
    operationId: 'b1',
    expiresAt: 'x',
    summary: { ...summary, canApply: false, conflicts: ['Other.ts'] },
  });
  await showGroup();
  await click('↓ Pull all');
  expect(named('Apply')).toBeUndefined();
  expect(root.querySelector('.dialog')?.textContent).toContain('nothing will run');
});

it('reports a failed member and retries only the unfinished batch', async () => {
  handlers['POST /api/v2/groups/g1/bulk'] = () => ({ operationId: 'b1', expiresAt: 'x', summary });
  handlers['POST /api/v2/group-operations/b1/apply'] = () => ({
    ...batch('failed'),
    members: [
      { repoId: 'r1', state: 'completed' },
      { repoId: 'r2', state: 'failed', error: 'disk full' },
    ],
    error: '1 member failed',
  });
  handlers['POST /api/v2/group-operations/b1/retry'] = () => ({
    operationId: 'b2',
    state: 'pending',
    expiresAt: 'x',
    members: [{ repoId: 'r2', state: 'pending' }],
  });
  handlers['POST /api/v2/group-operations/b2/apply'] = () => ({
    operationId: 'b2',
    state: 'completed',
    expiresAt: 'x',
    members: [{ repoId: 'r2', state: 'completed' }],
  });
  await showGroup();
  await click('↓ Pull all');
  await click('Apply');
  expect(root.querySelector('.grp-run')?.textContent).toContain('disk full');
  await click('Retry unfinished');
  expect(calls.find((call) => call.path.endsWith('/b2/apply'))?.body).toEqual({
    members: [{ repoId: 'r2', deletions: false, profiles: false }],
  });
  expect(toasts.value.at(-1)?.message).toContain('Pull complete');
});

it('changes a member push target through the group record', async () => {
  handlers['PUT /api/v2/groups/g1'] = () => group;
  await showGroup();
  await click('Change push target of acme-api/');
  await click('feat/y');
  expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
    revision: 'rev1',
    group: {
      name: 'claims',
      members: [
        { repoId: 'r1', workspaceId: 'w1', worktree: '/src/api/.worktrees/y' },
        { repoId: 'r2', workspaceId: 'w2', worktree: '/src/web' },
      ],
    },
  });
});

it('reports a group that cannot be loaded', async () => {
  delete handlers['GET /api/v2/groups/g1'];
  await showGroup();
  expect(root.textContent).toContain('Could not load this group');
});
