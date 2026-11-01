// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  NewCloakContext,
  NewCloakReview,
  Overview,
  TreeNode,
} from '../../src/web/api/contracts.js';
import { NewCloakScreen } from '../../src/web/screens/new/index.js';
import { startSession } from '../../src/web/shell/load.js';
import { overview } from '../../src/web/shell/state.js';
import { route } from '../../src/web/shell/router.js';
import { toasts } from '../../src/web/shell/ui/index.js';

const data: Overview = {
  launch: { kind: 'repo', repoId: 'r1', label: 'api', path: '/src/tree', branch: 'feat/x' },
  repos: [{ id: 'r1', name: 'api', path: '/src', missing: false, workspaceCount: 1 }],
  groups: [],
  workspaces: [],
  pendingAgentRequests: 0,
  profileCount: 1,
  workspacesRoot: '/cloaks',
};
const context: NewCloakContext = {
  repoId: 'r1',
  worktree: '/src/tree',
  branch: 'feat/x',
  ahead: 3,
  existing: [],
  destinationRoot: '/cloaks',
  destinationLocked: true,
  groups: [{ id: 'g1', name: 'claims', workspaceCount: 2 }],
};
const cleanReview: NewCloakReview = {
  files: 2,
  lines: 2900,
  heldBack: [{ path: 'db/Thing.cs', rule: '*.cs' }],
  replacements: [{ find: 'Contoso', replace: 'Acme', hits: 212 }],
  pathPreview: [
    { source: 'api', cloaked: 'acme-api' },
    { source: 'src/Contoso.ts', cloaked: 'src/Acme.ts' },
  ],
  leftovers: [],
  cli: 'repo-cloak pull --working -p contoso',
};
const nodes: TreeNode[] = [
  { path: 'db', kind: 'folder', files: 0, excludedBy: '*.cs' },
  { path: 'src', kind: 'folder', files: 4, excludedBy: null },
];

type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let review: NewCloakReview;
let overrides: Record<string, () => { status?: number; body: unknown }>;
let root: HTMLElement;
let stop: () => void;

const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://x');
  const method = init?.method ?? 'GET';
  const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ method, path: url.pathname, body });
  const key = `${method} ${url.pathname}`;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const override = overrides[key];
  if (override) {
    const result = override();
    return json(result.body, result.status);
  }
  switch (key) {
    case 'GET /api/v2/session':
      return json({ store: {}, policy: {} });
    case 'GET /api/v2/overview':
      return json(data);
    case 'GET /api/v2/new/context':
      return json(context);
    case 'GET /api/v2/profiles':
      return json({
        profiles: [
          {
            id: 'p1',
            name: 'contoso',
            scope: { kind: 'global' },
            ruleCount: 46,
            exclusionCount: 3,
          },
          {
            id: 'p2',
            name: 'Never pull',
            scope: { kind: 'global' },
            ruleCount: 0,
            exclusionCount: 8,
          },
        ],
      });
    case 'GET /api/v2/worktrees/r1':
      return json({
        worktrees: [
          { path: '/src', branch: 'main' },
          { path: '/src/tree', branch: 'feat/x' },
        ],
      });
    case 'GET /api/v2/settings':
      return json({ postCreateCommands: ['code {dest}'] });
    case 'GET /api/v2/new/changes':
      return json({
        uncommitted: [
          { path: 'a.ts', status: 'M', excluded: false },
          { path: 'new.ts', status: '?', excluded: false },
          { path: 'gone.ts', status: 'D', excluded: false },
          { path: 'x.lock', status: 'M', excluded: true },
        ],
        commits: [
          { sha: 'a41d2b7aaaa', subject: 'claims: stream', when: '2026-01-01T00:00:00Z', files: 3 },
        ],
        nextOffset: null,
      });
    case 'GET /api/v2/new/tree':
      return json({ nodes });
    case 'POST /api/v2/new/review':
      return json(review);
    case 'POST /api/v2/new/create':
      return json({
        operationId: 'op1',
        expiresAt: 'x',
        summary: { canApply: true, conflicts: [] },
      });
    case 'POST /api/v2/operations/op1/apply':
      return json({
        operationId: 'op1',
        state: 'completed',
        expiresAt: 'x',
        result: { workspaceId: 'w9', writes: ['a', 'b'], warnings: [] },
      });
    default:
      return json({ error: `Not found: ${key}` }, 404);
  }
});

const flush = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 350));
  });
const text = () => root.textContent ?? '';
const createButton = () => root.querySelector<HTMLButtonElement>('.review-create');
const posted = (path: string) =>
  calls
    .filter((call) => call.method === 'POST' && call.path === path)
    .map((call) => call.body) as Record<string, unknown>[];

beforeEach(async () => {
  calls = [];
  review = cleanReview;
  overrides = {};
  toasts.value = [];
  location.hash = '#/new';
  overview.value = data;
  stop = startSession({ token: 't', launch: {}, route: '#/new' }, fake as unknown as typeof fetch);
  root = document.createElement('div');
  document.body.append(root);
  act(() => render(<NewCloakScreen />, root));
  await flush();
  await flush();
});
afterEach(() => {
  act(() => render(null, root));
  root.remove();
  stop();
  overview.value = null;
  route.value = { screen: 'home' };
});

it('shows the detected worktree, branch and ahead count, with no existing-cloak choice', () => {
  expect(text()).toContain('worktree tree of api');
  expect(text()).toContain('feat/x');
  expect(text()).toContain('3 ahead of main');
  expect(text()).not.toContain('Already cloaked as');
});

it('selects uncommitted files except deleted and excluded ones, and reviews them', () => {
  expect(text()).toContain('2 of 2');
  expect(posted('/api/v2/new/review').at(-1)).toMatchObject({
    repoId: 'r1',
    worktree: '/src/tree',
    uncommitted: ['a.ts', 'new.ts'],
    commits: [],
    paths: [],
    profiles: [{ id: 'p1', scope: { kind: 'global' } }],
  });
});

it('renders the live review: counts, held back, replacements, path preview, CLI', () => {
  const aside = root.querySelector('aside');
  expect(aside?.textContent).toContain('2.9k');
  expect(aside?.textContent).toContain('db/Thing.cs');
  expect(aside?.textContent).toContain('*.cs');
  expect(aside?.textContent).toContain('Contoso');
  expect(aside?.textContent).toContain('212');
  expect(aside?.textContent).toContain('src/Acme.ts');
  expect(aside?.textContent).toContain('repo-cloak pull --working -p contoso');
  expect(aside?.textContent).toContain('planned');
});

it('shows excluded tree nodes locked, without a checkbox', () => {
  const tree = root.querySelector('.tree');
  expect(tree?.textContent).toContain('excluded · *.cs');
  expect(tree?.querySelector('input[aria-label="Pick db"]')).toBeNull();
  expect(tree?.querySelector('input[aria-label="Pick src"]')).not.toBeNull();
});

it('reviews again when a commit or tree node is picked', async () => {
  const commit = root.querySelector<HTMLInputElement>('.commit input');
  act(() => commit?.click());
  const pick = root.querySelector<HTMLInputElement>('input[aria-label="Pick src"]');
  act(() => pick?.click());
  await flush();
  expect(posted('/api/v2/new/review').at(-1)).toMatchObject({
    commits: ['a41d2b7aaaa'],
    paths: ['src'],
  });
});

it('suggests the name from the cloaked folder, shows the locked destination, and keeps edits', () => {
  const name = root.querySelector<HTMLInputElement>('.sheet-cell input');
  expect(name?.value).toMatch(/^acme-api-[0-9a-f]{4}$/);
  expect(text()).toContain(`→ /cloaks/${name?.value}`);
  expect(text()).toContain('fixed in Settings');
});

it('lists group choices with standalone as the default', () => {
  const select = root.querySelector<HTMLSelectElement>('.sheet-cell select');
  expect(select?.value).toBe('');
  expect([...(select?.options ?? [])].map((item) => item.textContent)).toEqual([
    'No group',
    'claims (2)',
    'New group…',
  ]);
});

it('loads default post-create commands and offers every variable', () => {
  expect(root.querySelector<HTMLInputElement>('.command input')?.value).toBe('code {dest}');
  for (const name of ['{dest}', '{source}', '{branch}', '{name}', '{group}', '{sha}'])
    expect(text()).toContain(name);
});

it('blocks create on a leftover until ignored, and ignoring only covers those names', async () => {
  review = { ...cleanReview, leftovers: [{ path: 'a.ts', name: 'ch-prod-sql01' }] };
  act(() => root.querySelector<HTMLButtonElement>('.file-chip')?.click());
  await flush();
  expect(text()).toContain('ch-prod-sql01');
  expect(createButton()?.disabled).toBe(true);
  const ignore = [...root.querySelectorAll('button')].find((item) => item.textContent === 'Ignore');
  act(() => ignore?.click());
  await flush();
  expect(createButton()?.disabled).toBe(false);
  review = { ...cleanReview, leftovers: [{ path: 'a.ts', name: 'another-name' }] };
  act(() => root.querySelector<HTMLButtonElement>('.file-chip')?.click());
  await flush();
  expect(createButton()?.disabled).toBe(true);
});

it('labels leftover checks as heuristic and shows the kind and a partial scan', async () => {
  review = {
    ...cleanReview,
    leftovers: [{ path: 'a.ts', name: 'ch-prod-sql01', kind: 'server' }],
    leakScan: { filesScanned: 2, filesTotal: 9, partial: true },
  };
  act(() => root.querySelector<HTMLButtonElement>('.file-chip')?.click());
  await flush();
  expect(text()).toContain('1 possible leftover with no rule');
  expect(text()).toContain('ch-prod-sql01 · server in a.ts');
  const note = root.querySelector('[data-leak-scan]')?.textContent;
  expect(note).toContain('stopped at a limit after 2 of 9 files');
  expect(note).toContain('heuristic');
  expect(note).not.toContain('Spotted no likely leftovers');
});

it('does not call a quiet leftover check safe', async () => {
  review = { ...cleanReview, leakScan: { filesScanned: 2, filesTotal: 2, partial: false } };
  act(() => root.querySelector<HTMLButtonElement>('.file-chip')?.click());
  await flush();
  const note = root.querySelector('[data-leak-scan]')?.textContent;
  expect(note).toContain('Spotted no likely leftovers');
  expect(note).toContain('not proof of safety');
  expect(note).not.toContain('Partial');
});

it('blocks create with no profile', async () => {
  act(() => root.querySelector<HTMLButtonElement>('.profile-chip-on')?.click());
  await flush();
  expect(createButton()?.disabled).toBe(true);
  expect(text()).toContain('Choose at least one profile.');
});

it('shows a review failure and blocks create', async () => {
  overrides['POST /api/v2/new/review'] = () => ({
    status: 400,
    body: { error: 'a conflicts with b: same original, different replacements' },
  });
  act(() => root.querySelector<HTMLButtonElement>('.file-chip')?.click());
  await flush();
  expect(root.querySelector('aside [role="alert"]')?.textContent).toContain('conflicts with');
  expect(createButton()?.disabled).toBe(true);
});

it('creates on the button, applies, refreshes and lands on the new workspace', async () => {
  expect(createButton()?.textContent).toBe('Create cloak · 2 files');
  await act(async () => {
    createButton()?.click();
    await new Promise((done) => setTimeout(done, 20));
  });
  const body = posted('/api/v2/new/create')[0];
  expect(body).toMatchObject({
    uncommitted: ['a.ts', 'new.ts'],
    postCreateCommands: ['code {dest}'],
    ignoreLeftovers: false,
  });
  expect(body?.destination).toBe(`/cloaks/${String(body?.name)}`);
  expect(body).not.toHaveProperty('groupId');
  expect(posted('/api/v2/operations/op1/apply')[0]).toEqual({ profiles: true });
  expect(location.hash).toBe('#/ws/w9');
  expect(toasts.value[0]?.message).toBe('Cloak created · 2 files');
});

it('creates with ⌘↵ and cancels with esc', async () => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(posted('/api/v2/new/create')).toHaveLength(1);
  location.hash = '#/new';
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  });
  expect(location.hash).toBe('#/');
});

it('joins the chosen group after creating, standalone first', async () => {
  overrides['GET /api/v2/groups/g1'] = () => ({ body: { revision: 'rev1' } });
  overrides['POST /api/v2/groups/g1/members'] = () => ({ body: {} });
  const select = root.querySelector<HTMLSelectElement>('.sheet-cell select');
  act(() => {
    if (select) {
      select.value = 'g1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await flush();
  await act(async () => {
    createButton()?.click();
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(posted('/api/v2/new/create')[0]).toMatchObject({ groupId: 'g1' });
  expect(posted('/api/v2/groups/g1/members')[0]).toEqual({
    revision: 'rev1',
    member: { repoId: 'r1', workspaceId: 'w9', worktree: '/src/tree' },
  });
  expect(location.hash).toBe('#/ws/w9');
});

it('keeps the cloak and says so when joining the group fails', async () => {
  overrides['GET /api/v2/groups/g1'] = () => ({ status: 409, body: { error: 'Group changed' } });
  const select = root.querySelector<HTMLSelectElement>('.sheet-cell select');
  act(() => {
    if (select) {
      select.value = 'g1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await flush();
  await act(async () => {
    createButton()?.click();
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(location.hash).toBe('#/ws/w9');
  expect(toasts.value.map((item) => item.message)).toContain(
    'Cloak created, but it could not join the group: Group changed',
  );
});

it('stays on the sheet and reports it when the server refuses to create', async () => {
  overrides['POST /api/v2/new/create'] = () => ({
    status: 409,
    body: { error: '1 real names have no rule' },
  });
  await act(async () => {
    createButton()?.click();
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(location.hash).toBe('#/new');
  expect(root.querySelector('.new-error')?.textContent).toContain('1 real names have no rule');
});

it('offers Open, Add to it and New for an existing cloak, and Add targets that cloak', async () => {
  act(() => render(null, root));
  overrides['GET /api/v2/new/context'] = () => ({
    body: {
      ...context,
      existing: [{ repoId: 'r1', workspaceId: 'w1', name: 'acme-7c1e', path: '/cloaks/acme-7c1e' }],
    },
  });
  act(() => render(<NewCloakScreen />, root));
  await flush();
  await flush();
  expect(text()).toContain('Already cloaked as');
  expect(
    root.querySelector<HTMLAnchorElement>('.new-banner-existing a')?.getAttribute('href'),
  ).toBe('#/ws/w1');
  const add = [...root.querySelectorAll('button')].find((item) => item.textContent === 'Add to it');
  act(() => add?.click());
  await flush();
  expect(posted('/api/v2/new/review').at(-1)).toMatchObject({ profiles: [] });
  expect(root.querySelector('.sheet-row')).toBeNull();
  expect(createButton()?.textContent).toBe('Add to acme-7c1e · 2 files');
  await act(async () => {
    createButton()?.click();
    await new Promise((done) => setTimeout(done, 20));
  });
  expect(posted('/api/v2/new/create')[0]).toMatchObject({
    name: 'acme-7c1e',
    destination: '/cloaks/acme-7c1e',
    postCreateCommands: [],
  });
});

it('asks for a folder when Settings does not fix the destination', async () => {
  act(() => render(null, root));
  overrides['GET /api/v2/new/context'] = () => ({
    body: { ...context, destinationRoot: null, destinationLocked: false },
  });
  act(() => render(<NewCloakScreen />, root));
  await flush();
  await flush();
  expect(text()).toContain('Choose where the cloak goes.');
  expect(createButton()?.disabled).toBe(true);
  expect(text()).not.toContain('fixed in Settings');
  expect(text()).toContain('Browse');
});
