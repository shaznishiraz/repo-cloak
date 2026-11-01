// @vitest-environment happy-dom
import { render } from 'preact';
import type { ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readSession } from '../../src/web/api/session.js';
import type {
  AgentRequest,
  AgentRequestDetail,
  AuditEventView,
  DashboardSettings,
  KnownRepo,
  RepoDetail,
} from '../../src/web/api/contracts.js';
import { HistoryScreen, whenLabel } from '../../src/web/screens/history/index.js';
import { ReposScreen, treeLabel } from '../../src/web/screens/repos/index.js';
import { ago } from '../../src/web/screens/repos/shared.js';
import { RequestsScreen, filterRequests } from '../../src/web/screens/requests/index.js';
import { createIdleLock, lockTab } from '../../src/web/screens/settings/auto-lock.js';
import {
  SettingsScreen,
  changedFields,
  numberProblem,
} from '../../src/web/screens/settings/index.js';
import { commands } from '../../src/web/shell/commands.js';
import { startSession } from '../../src/web/shell/load.js';
import { overview, sessionInfo } from '../../src/web/shell/state.js';
import { toasts } from '../../src/web/shell/ui/index.js';

type Call = { method: string; path: string; body: unknown };
type Reply = unknown | ((call: Call) => unknown);
let root: HTMLElement;
let calls: Call[];
let stop: () => void;

class Failure {
  constructor(
    readonly status: number,
    readonly error: string,
  ) {}
}
function serve(table: Record<string, Reply>) {
  calls = [];
  const request = ((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://x');
    const method = init?.method ?? 'GET';
    const call = {
      method,
      path: `${url.pathname}${url.search}`,
      body: init?.body ? (JSON.parse(init.body as string) as unknown) : undefined,
    };
    calls.push(call);
    const reply =
      table[`${method} ${call.path}`] ??
      table[`${method} ${url.pathname}`] ??
      new Failure(404, `No fake for ${method} ${call.path}`);
    const value = typeof reply === 'function' ? (reply as (c: Call) => unknown)(call) : reply;
    return Promise.resolve(
      value instanceof Failure
        ? new Response(JSON.stringify({ error: value.error }), { status: value.status })
        : new Response(JSON.stringify(value)),
    );
  }) as typeof fetch;
  stop = startSession({ token: 't', launch: {}, route: '#/' }, request);
}
// Loads chain: a list arrives, its effect loads the detail. Effects flush as each act ends.
async function settle() {
  for (let round = 0; round < 4; round++)
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
}
async function show(node: ComponentChildren) {
  await act(() => {
    render(node, root);
  });
  await settle();
}
function byText(text: string, selector = 'button,a,[role=tab]') {
  return [...root.querySelectorAll<HTMLElement>(selector)].find((item) =>
    item.textContent?.includes(text),
  );
}
async function click(text: string) {
  const target = byText(text);
  if (!target) throw new Error(`No control named ${text}`);
  await act(() => target.click());
  await settle();
}
const sent = (method: string, path: string) =>
  calls.filter((call) => call.method === method && call.path.startsWith(path));

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
afterEach(() => {
  render(null, root);
  root.remove();
  stop?.();
  toasts.value = [];
  overview.value = null;
  sessionInfo.value = null;
  vi.useRealTimers();
});

const settings: DashboardSettings = {
  workspacesRoot: '/c',
  postCreateCommands: [],
  security: {
    keyStorage: 'auto',
    auditRetentionDays: null,
    allowExclusionOverride: true,
    autoLockMinutes: null,
    lockedExclusions: [],
    locked: [],
    policy: { status: 'none', path: null, signed: false },
  },
};
const base = {
  'GET /api/v2/session': {
    app: 'repo-cloak',
    protocol: 1,
    version: '2',
    port: 1,
    store: {
      sealed: true,
      keyId: 'k_1',
      storage: 'file',
      migrationAvailable: false,
      rotationPending: false,
    },
    policy: { status: 'none', locked: [] },
    auditFailures: 0,
  },
  'GET /api/v2/overview': {
    launch: { kind: 'none' },
    repos: [],
    groups: [],
    workspaces: [],
    pendingAgentRequests: 0,
    profileCount: 0,
    workspacesRoot: null,
  },
  'GET /api/v2/settings': settings,
};

/* ---------- Known repos ---------- */

const repo = (over: Partial<KnownRepo> = {}): KnownRepo => ({
  id: 'a'.repeat(16),
  name: 'alpha',
  path: '/src/alpha',
  missing: false,
  workspaceCount: 1,
  pinned: false,
  worktreeCount: 2,
  lastUsedAt: null,
  ...over,
});
const detail = (over: Partial<KnownRepo> = {}): RepoDetail => ({
  repo: repo(over),
  worktrees: [
    { path: '/src/alpha', isMain: true, branch: 'main', ahead: 0, behind: 0, workspace: null },
    {
      path: '/src/alpha/.w/x',
      isMain: false,
      branch: 'feat/x',
      ahead: 3,
      behind: 1,
      workspace: { id: 'w1', name: 'cloak-one' },
    },
  ],
  rules: { defaultProfiles: ['names'], exclude: ['**/PHI/**'], allowedRoots: [] },
  exposure: { filesOut: 61, workspaces: 1 },
});

it('shows repos pinned first, worktrees with ahead/behind and Cloak/Open, rules and exposure', async () => {
  serve({
    ...base,
    'GET /api/v2/repos': {
      repos: [repo(), repo({ id: 'b'.repeat(16), name: 'beta', pinned: true })],
    },
    [`GET /api/v2/repos/${'b'.repeat(16)}`]: detail({
      id: 'b'.repeat(16),
      name: 'beta',
      pinned: true,
    }),
  });
  await show(<ReposScreen />);
  const names = [...root.querySelectorAll('.adm-pick .adm-mono-cut:first-child')].map(
    (item) => item.textContent,
  );
  expect(names).toEqual(['beta', 'alpha']);
  const text = root.textContent ?? '';
  expect(text).toContain('up to date');
  expect(text).toContain('↑3 ↓1');
  expect(byText('Open')?.getAttribute('href')).toBe('#/ws/w1');
  expect(byText('Cloak')?.getAttribute('href')).toBe('#/new');
  expect(text).toContain('**/PHI/**');
  expect(text).toContain('61');
  expect(text).toContain('Not enforced yet');
});

it('labels linked worktrees relative to their repo', () => {
  expect(treeLabel('/src/a/.worktrees/x', '/src/a')).toBe('.worktrees/x');
  expect(treeLabel('/src/a-other', '/src/a')).toBe('/src/a-other');
  expect(treeLabel('/src/a', '/src/a')).toBe('/src/a');
});

it('pins a repo, edits exclusions and forgets a repo through the API', async () => {
  const id = 'a'.repeat(16);
  serve({
    ...base,
    'GET /api/v2/repos': { repos: [repo()] },
    [`GET /api/v2/repos/${id}`]: detail(),
    [`PUT /api/v2/repos/${id}`]: detail({ pinned: true }),
    [`DELETE /api/v2/repos/${id}`]: { removed: id },
  });
  await show(<ReposScreen />);
  const star = root.querySelector<HTMLElement>('.adm-star');
  await act(() => star?.click());
  await settle();
  expect(sent('PUT', `/api/v2/repos/${id}`)[0]?.body).toEqual({ pinned: true });

  await click('Edit exclusions');
  const area = root.querySelector<HTMLTextAreaElement>('textarea');
  expect(area?.value).toBe('**/PHI/**');
  await act(() => {
    if (!area) return;
    area.value = 'a/**\n\n  b/** ';
    area.dispatchEvent(new Event('input'));
  });
  await click('Save exclusions');
  expect(sent('PUT', `/api/v2/repos/${id}`)[1]?.body).toEqual({
    rules: { defaultProfiles: ['names'], exclude: ['a/**', 'b/**'], allowedRoots: [] },
  });

  await click('Forget repo');
  const confirm = [...root.querySelectorAll<HTMLElement>('.dialog .btn-danger')].at(-1);
  await act(() => confirm?.click());
  await settle();
  expect(sent('DELETE', `/api/v2/repos/${id}`)).toHaveLength(1);
});

it('adds a repo by typed path and shows why one was refused', async () => {
  serve({
    ...base,
    'GET /api/v2/repos': { repos: [repo()] },
    [`GET /api/v2/repos/${'a'.repeat(16)}`]: detail(),
    'POST /api/v2/repos': new Failure(400, 'The selected folder is not a Git repository'),
  });
  await show(<ReposScreen />);
  const input = root.querySelector<HTMLInputElement>('.dialog input');
  await act(() => {
    if (!input) return;
    input.value = '/nope';
    input.dispatchEvent(new Event('input'));
  });
  await act(() => root.querySelector<HTMLElement>('.dialog .btn-primary')?.click());
  await settle();
  expect(sent('POST', '/api/v2/repos')[0]?.body).toEqual({ path: '/nope' });
  expect(root.querySelector('.dialog')?.textContent).toContain('not a Git repository');
});

/* ---------- Agent requests ---------- */

const agentRequest = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  id: 'r1:src/A.ts',
  repoId: 'a'.repeat(16),
  workspaceId: 'w1',
  workspaceName: 'cloak-one',
  path: 'src/A.ts',
  reason: '<img src=x onerror=alert(1)> I need it',
  state: 'waiting',
  createdAt: new Date().toISOString(),
  ...over,
});
const requestDetail = (over: Partial<AgentRequestDetail> = {}): AgentRequestDetail => ({
  ...agentRequest(),
  checks: [{ id: 'recheck', state: 'ok', title: 'Source re-checked' }],
  preview: 'class Northwind {}',
  ...over,
});

it('sorts requests into waiting and decided', () => {
  const list = (['waiting', 'blocked', 'failed', 'pulled', 'denied'] as const).map((state) =>
    agentRequest({ state }),
  );
  expect(filterRequests(list, 'waiting').map((item) => item.state)).toEqual([
    'waiting',
    'blocked',
    'failed',
  ]);
  expect(filterRequests(list, 'decided').map((item) => item.state)).toEqual(['pulled', 'denied']);
  expect(filterRequests(list, 'all')).toHaveLength(5);
});

const requestUrl = `/api/v2/requests/w1/${encodeURIComponent('r1:src/A.ts')}`;

it('shows state, reason as plain text, the policy check and the cloaked preview', async () => {
  serve({
    ...base,
    'GET /api/v2/requests': { requests: [agentRequest()] },
    [`GET ${requestUrl}`]: requestDetail(),
  });
  await show(<RequestsScreen />);
  const text = root.textContent ?? '';
  expect(byText('Waiting 1', '[role=tab]')).toBeTruthy();
  expect(text).toContain('waiting');
  expect(text).toContain('Source re-checked');
  expect(root.querySelector('pre')?.textContent).toBe('class Northwind {}');
  expect(root.querySelector('.adm-reason')?.textContent).toContain('<img src=x');
  expect(root.querySelector('.adm-reason img')).toBeNull();
});

it('approves and denies through the API, and refetches the inbox', async () => {
  serve({
    ...base,
    'GET /api/v2/requests': { requests: [agentRequest()] },
    [`GET ${requestUrl}`]: requestDetail(),
    [`POST ${requestUrl}`]: (call: Call) =>
      requestDetail({
        state: (call.body as { decision: string }).decision === 'deny' ? 'denied' : 'pulled',
      }),
  });
  await show(<RequestsScreen />);
  const before = sent('GET', '/api/v2/requests').length;
  await click('Approve & pull');
  expect(sent('POST', requestUrl)[0]?.body).toEqual({ decision: 'approve', mode: 'full' });
  expect(sent('GET', '/api/v2/requests').length).toBeGreaterThan(before);
  expect(byText('Approve & pull')).toBeUndefined();
});

it('denies through the API', async () => {
  serve({
    ...base,
    'GET /api/v2/requests': { requests: [agentRequest()] },
    [`GET ${requestUrl}`]: requestDetail(),
    [`POST ${requestUrl}`]: requestDetail({ state: 'denied' }),
  });
  await show(<RequestsScreen />);
  await click('Deny');
  expect(sent('POST', requestUrl)[0]?.body).toEqual({ decision: 'deny' });
});

it('cannot approve a blocked file, and does not offer what the engine cannot do', async () => {
  serve({
    ...base,
    'GET /api/v2/requests': { requests: [agentRequest({ state: 'blocked' })] },
    [`GET ${requestUrl}`]: requestDetail({
      state: 'blocked',
      preview: null,
      checks: [{ id: 'exclusions', state: 'blocked', title: 'Matches an exclusion' }],
    }),
  });
  await show(<RequestsScreen />);
  expect((byText('Approve & pull') as HTMLButtonElement).disabled).toBe(true);
  expect((byText('Send signatures only') as HTMLButtonElement).disabled).toBe(true);
  expect(root.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled).toBe(true);
  expect(root.querySelector('pre')).toBeNull();
});

it('says when the shell counts more requests than the inbox can read', async () => {
  serve({ ...base, 'GET /api/v2/requests': { requests: [] } });
  await show(<RequestsScreen />);
  await act(() => {
    overview.value = { ...base['GET /api/v2/overview'], pendingAgentRequests: 2 } as never;
  });
  expect(root.textContent).toContain('2 more waiting');
});

/* ---------- History ---------- */

const auditEvent = (over: Partial<AuditEventView> = {}): AuditEventView => ({
  seq: 2,
  at: new Date().toISOString(),
  who: 'sam',
  op: 'pull',
  outcome: 'ok',
  workspace: { id: 'w1', name: 'cloak-one' },
  files: Array.from({ length: 7 }, (_, index) => ({
    path: `f${index}.ts`,
    hash: `sha256-${'a'.repeat(64)}`,
  })),
  profiles: [],
  keyId: 'k_1',
  detail: 'from main',
  hash: `sha256-${'b'.repeat(64)}`,
  prevHash: `sha256-${'c'.repeat(64)}`,
  ...over,
});

it('labels event times and ages', () => {
  const now = new Date('2026-11-05T12:00:00');
  expect(whenLabel(new Date('2026-11-05T09:30:00').toISOString(), now)).toMatch(/^today 09:30$/);
  expect(whenLabel(new Date('2026-11-04T09:30:00').toISOString(), now)).toBe('yesterday');
  expect(whenLabel(new Date('2026-11-01T09:30:00').toISOString(), now)).toBe('4d ago');
  const at = Date.parse('2026-11-05T12:00:00Z');
  expect(ago('2026-11-05T11:20:00Z', at)).toBe('40m');
  expect(ago('2026-11-05T07:00:00Z', at)).toBe('5h');
  expect(ago('2026-11-02T12:00:00Z', at)).toBe('3d');
  expect(ago(null)).toBe('—');
});

it('shows the table and event detail, sends filters and pages older events', async () => {
  serve({
    ...base,
    'GET /api/v2/audit': {
      events: [
        auditEvent({ prevHash: `sha256-${'d'.repeat(64)}` }),
        auditEvent({ seq: 1, op: 'create', hash: `sha256-${'d'.repeat(64)}`, files: [] }),
      ],
      total: 3,
      nextCursor: 1,
    },
    'GET /api/v2/audit?cursor=1': {
      events: [auditEvent({ seq: 0, op: 'settings', files: [] })],
      total: 3,
      nextCursor: null,
    },
    'GET /api/v2/audit?q=op%3Apull': { events: [auditEvent()], total: 1, nextCursor: null },
    'POST /api/v2/audit/verify': { ok: true, count: 3, headHash: 'x' },
  });
  await show(<HistoryScreen />);
  expect(root.textContent).toContain('✓ chain verified · 3 events');
  const aside = () => root.querySelector('.adm-aside')?.textContent ?? '';
  expect(aside()).toContain('event #2');
  expect(aside()).toContain('✓ links #1');
  expect(aside()).toContain('Files (7)');
  expect(root.querySelectorAll('.adm-file')).toHaveLength(5);
  await click('Show all 7');
  expect(root.querySelectorAll('.adm-file')).toHaveLength(7);
  await click('Load older events');
  expect(root.querySelectorAll('button.adm-event')).toHaveLength(3);

  const input = root.querySelector<HTMLInputElement>('.adm-filter input');
  await act(() => {
    if (!input) return;
    input.value = 'op:pull';
    input.dispatchEvent(new Event('input'));
  });
  await act(() => new Promise((done) => setTimeout(done, 300)));
  await settle();
  expect(root.querySelectorAll('button.adm-event')).toHaveLength(1);
});

it('reports a broken chain and a rejected filter without losing the rows', async () => {
  serve({
    ...base,
    'GET /api/v2/audit': { events: [auditEvent()], total: 1, nextCursor: null },
    'GET /api/v2/audit?q=op%3Anope': new Failure(400, 'op: use one of pull'),
    'POST /api/v2/audit/verify': {
      ok: false,
      count: 1,
      firstBroken: { line: 4, seq: 3, reason: 'Line cannot be authenticated' },
    },
  });
  await show(<HistoryScreen />);
  expect(root.textContent).toContain('chain broken at line 4: Line cannot be authenticated');
  const input = root.querySelector<HTMLInputElement>('.adm-filter input');
  await act(() => {
    if (!input) return;
    input.value = 'op:nope';
    input.dispatchEvent(new Event('input'));
  });
  await act(() => new Promise((done) => setTimeout(done, 300)));
  await settle();
  expect(root.textContent).toContain('op: use one of pull');
  expect(root.querySelectorAll('button.adm-event')).toHaveLength(1);
});

it('downloads the signed export and registers palette commands', async () => {
  const created = vi.fn(() => 'blob:x');
  URL.createObjectURL = created;
  URL.revokeObjectURL = vi.fn();
  serve({
    ...base,
    'GET /api/v2/audit': { events: [], total: 0, nextCursor: null },
    'POST /api/v2/audit/verify': { ok: true, count: 0, headHash: null },
    'POST /api/v2/audit/export': { jsonl: '{}\n', signature: 's', publicKey: 'p' },
  });
  await show(<HistoryScreen />);
  expect(commands.value.map((command) => command.id)).toEqual(
    expect.arrayContaining(['audit-verify', 'audit-export']),
  );
  await click('Export signed log');
  expect(created).toHaveBeenCalledOnce();
  expect(toasts.value[0]?.message).toContain('one-time key');
});

/* ---------- Settings ---------- */

const locked: DashboardSettings = {
  ...settings,
  security: {
    ...settings.security,
    auditRetentionDays: 365,
    allowExclusionOverride: false,
    lockedExclusions: ['**/*.pem'],
    locked: ['lockedExclusions', 'auditRetentionDays', 'allowExclusionOverride'],
    policy: { status: 'active', path: '/etc/repo-cloak/policy.json', signed: true },
  },
};
const settingsServer = (value: DashboardSettings, more: Record<string, Reply> = {}) => ({
  ...base,
  'GET /api/v2/settings': value,
  ...more,
});
vi.stubGlobal('fetch', ((input: string) =>
  input === '/supply-chain.json'
    ? Promise.resolve(
        new Response(
          JSON.stringify({
            version: '2',
            directDependencies: 12,
            productionPackages: 20,
            installScriptsAllowed: false,
            pinned: true,
            integrityHashes: true,
            bundledBrowserPackages: [],
          }),
        ),
      )
    : Promise.reject(new Error('Unexpected fetch'))) as typeof fetch);

it('sends only the fields that changed', () => {
  const draft = {
    workspacesRoot: '/c',
    commands: '',
    keyStorage: 'auto' as const,
    autoLock: '',
    retention: '',
    override: true,
  };
  expect(changedFields(settings, draft)).toEqual({});
  expect(changedFields(settings, { ...draft, autoLock: '15' })).toEqual({ autoLockMinutes: 15 });
  expect(
    changedFields(locked, { ...draft, autoLock: '15', retention: '365', override: false }),
  ).toEqual({
    autoLockMinutes: 15,
  });
  expect(changedFields(settings, { ...draft, commands: ' a \n\nb' })).toEqual({
    postCreateCommands: ['a', 'b'],
  });
  expect(
    changedFields(
      { ...settings, security: { ...settings.security, autoLockMinutes: 5 } },
      { ...draft, autoLock: '' },
    ),
  ).toEqual({
    autoLockMinutes: null,
  });
  expect(numberProblem('15')).toBeUndefined();
  expect(numberProblem('')).toBeUndefined();
  for (const bad of ['0', '-1', '1.5', 'x']) expect(numberProblem(bad), bad).toBeTruthy();
});

it('renders every section and saves a change', async () => {
  serve(
    settingsServer(settings, {
      'PUT /api/v2/settings': {
        ...settings,
        security: { ...settings.security, autoLockMinutes: 15 },
      },
    }),
  );
  await show(<SettingsScreen />);
  for (const title of [
    'Workspaces',
    'Security',
    'Global exclusions',
    'Audit & compliance',
    'Runs locally',
    'AI tools',
  ])
    expect(byText(title, '.panel-title'), title).toBeTruthy();
  expect(root.textContent).toContain('loopback only');
  expect(root.textContent).toContain('direct dependencies');
  expect((byText('Save') as HTMLButtonElement).disabled).toBe(true);
  const input = root.querySelector<HTMLInputElement>('input[placeholder=off]');
  await act(() => {
    if (!input) return;
    input.value = '15';
    input.dispatchEvent(new Event('input'));
  });
  await click('Save');
  expect(sent('PUT', '/api/v2/settings')[0]?.body).toEqual({ autoLockMinutes: 15 });
});

it('shows policy-locked fields as locked and the policy file status', async () => {
  serve(settingsServer(locked));
  await show(<SettingsScreen />);
  const text = root.textContent ?? '';
  expect(text).toContain('3 fields set by org policy · locked');
  expect(text).toContain('/etc/repo-cloak/policy.json');
  expect(text).toContain('signature valid');
  expect(text).toContain('**/*.pem');
  expect(root.querySelector<HTMLInputElement>('input[placeholder=forever]')?.disabled).toBe(true);
  expect(root.querySelector<HTMLInputElement>('.adm-setting input[type=checkbox]')?.disabled).toBe(
    true,
  );
  expect(root.querySelector<HTMLInputElement>('input[placeholder=off]')?.disabled).toBe(false);
});

it('flags an invalid policy, rejects a bad number and shows a refused save', async () => {
  const invalid: DashboardSettings = {
    ...settings,
    security: {
      ...settings.security,
      policy: { status: 'invalid', path: '/etc/p.json', signed: false, message: 'Bad signature' },
    },
  };
  serve(
    settingsServer(invalid, { 'PUT /api/v2/settings': new Failure(400, 'Root is inside a repo') }),
  );
  await show(<SettingsScreen />);
  expect(root.textContent).toContain('Bad signature');
  const lock = root.querySelector<HTMLInputElement>('input[placeholder=off]');
  await act(() => {
    if (!lock) return;
    lock.value = 'soon';
    lock.dispatchEvent(new Event('input'));
  });
  expect((byText('Save') as HTMLButtonElement).disabled).toBe(true);
  await act(() => {
    if (!lock) return;
    lock.value = '5';
    lock.dispatchEvent(new Event('input'));
  });
  await click('Save');
  expect(root.querySelector('[role=alert]')?.textContent).toContain('Root is inside a repo');
});

it('rotates the key only after confirming and reports cloaks it could not reach', async () => {
  serve(
    settingsServer(settings, {
      'POST /api/v2/settings/key/rotate': {
        keyId: 'k_2',
        previousKeyId: 'k_1',
        resealed: 3,
        pending: ['/gone'],
      },
    }),
  );
  await show(<SettingsScreen />);
  await click('Rotate key');
  expect(sent('POST', '/api/v2/settings/key/rotate')).toHaveLength(0);
  const confirm = root.querySelector<HTMLElement>('.dialog .btn-danger');
  await act(() => confirm?.click());
  await settle();
  expect(sent('POST', '/api/v2/settings/key/rotate')).toHaveLength(1);
  expect(toasts.value[0]?.message).toContain('1 unreachable');
});

it('manages agent access and MCP setup for the chosen cloak', async () => {
  serve(
    settingsServer(settings, {
      'GET /api/v2/agents/r/w1': { enabled: true, guidance: true },
      'PUT /api/v2/agents/r/w1': { enabled: false, guidance: true },
      'GET /api/v2/agents/r/w1/mcp': {
        name: 'repo-cloak-w1',
        command: 'node',
        args: [],
        codexTarget: '',
        claudeTarget: '',
        codex: 'c',
        claude: '{}',
      },
      'POST /api/v2/agents/r/w1/mcp/codex': { status: 'installed', message: 'Added' },
    }),
  );
  overview.value = {
    ...base['GET /api/v2/overview'],
    workspaces: [{ id: 'w1', repoId: 'r', name: 'cloak-one' }],
  } as never;
  sessionInfo.value = null;
  await show(<SettingsScreen />);
  // The session poll replaces the overview, so put the workspace back for this screen.
  await act(() => {
    overview.value = {
      ...base['GET /api/v2/overview'],
      workspaces: [{ id: 'w1', repoId: 'r', name: 'cloak-one' }],
    } as never;
  });
  await settle();
  expect(root.textContent).toContain('repo-cloak-w1');
  const toggle = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].at(-1);
  expect(toggle?.checked).toBe(true);
  await act(() => {
    if (!toggle) return;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
  });
  await settle();
  expect(sent('PUT', '/api/v2/agents/r/w1')[0]?.body).toEqual({ enabled: false });
  await click('Add to Codex');
  expect(sent('POST', '/api/v2/agents/r/w1/mcp/codex')[0]?.body).toEqual({ confirm: true });
});

/* ---------- Locking ---------- */

it('locking removes the session the browser would read back', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  expect(readSession('#token=secret&repo=abc', storage).token).toBe('secret');
  const reload = vi.fn();
  lockTab(storage, reload);
  expect(reload).toHaveBeenCalledOnce();
  expect(values.size).toBe(0);
  expect(readSession('#/settings', storage).token).toBeNull();
});

it('locks after the idle limit, resets on activity and stays off when unset', () => {
  vi.useFakeTimers();
  let now = 0;
  const lock = vi.fn();
  const idle = createIdleLock(lock, () => now);
  now = 10 * 60_000;
  idle.check();
  expect(lock).not.toHaveBeenCalled();
  idle.activity();
  idle.set(5);
  now += 4 * 60_000;
  idle.activity();
  now += 4 * 60_000;
  vi.advanceTimersByTime(15_000);
  expect(lock).not.toHaveBeenCalled();
  now += 60_000;
  vi.advanceTimersByTime(15_000);
  expect(lock).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(60_000);
  expect(lock).toHaveBeenCalledOnce();
});

it('locks on return when the tab sat idle past the limit', () => {
  let now = 0;
  const lock = vi.fn();
  const idle = createIdleLock(lock, () => now);
  idle.set(5);
  now = 6 * 60_000;
  idle.activity();
  expect(lock).toHaveBeenCalledOnce();
});
