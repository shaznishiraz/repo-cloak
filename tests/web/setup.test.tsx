// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SetupState } from '../../src/web/api/contracts.js';
import { SetupScreen } from '../../src/web/screens/setup/index.js';
import { startSession } from '../../src/web/shell/load.js';
import { overview, sessionInfo } from '../../src/web/shell/state.js';

const fresh: SetupState = {
  key: { exists: true, storage: 'file' },
  workspacesRoot: null,
  exclusionPresets: [
    { id: 'env', name: 'Env files', patterns: ['.env', '.env.*'], enabled: true },
    { id: 'keys', name: 'Keys', patterns: ['*.pem'], enabled: true },
  ],
  profileCount: 0,
  suggestedNames: ['Contoso', 'ContosoHealth'],
};
type Call = { method: string; path: string; body: unknown };
let calls: Call[];
let state: SetupState;
let failRoot: boolean;
let root: HTMLElement;
let stop: () => void;

const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://x');
  const method = init?.method ?? 'GET';
  const body = (typeof init?.body === 'string' ? JSON.parse(init.body) : undefined) as
    { workspacesRoot?: string; presets?: string[] } | undefined;
  calls.push({ method, path: url.pathname, body });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const key = `${method} ${url.pathname}`;
  if (key === 'GET /api/v2/setup') return json(state);
  if (key === 'PUT /api/v2/setup') {
    if (failRoot && body?.workspacesRoot) return json({ error: 'Inside a repository' }, 400);
    state = {
      ...state,
      suggestedNames: [],
      key: { exists: true, storage: 'file' },
      ...(body?.workspacesRoot ? { workspacesRoot: body.workspacesRoot } : {}),
    };
    return json(state);
  }
  if (key === 'POST /api/v2/profiles') return json({ id: 'p' });
  if (key === 'GET /api/v2/session')
    return json({ store: { keyId: 'k_3f9a00000c21', sealed: true }, policy: {} });
  if (key === 'GET /api/v2/overview') return json(overview.value);
  return json({ error: 'Not found' }, 404);
});

const flush = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 30));
  });
const button = (name: string, within: ParentNode = root) =>
  [...within.querySelectorAll('button')].find((item) => item.textContent === name);
const step = (name: string) => root.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
const type = (input: HTMLInputElement | null | undefined, value: string) =>
  act(() => {
    if (!input) throw new Error('No input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(async () => {
  calls = [];
  state = fresh;
  failRoot = false;
  location.hash = '#/setup';
  overview.value = {
    launch: { kind: 'repo', repoId: 'r1', label: 'x', path: '/x', branch: null },
    repos: [],
    groups: [],
    workspaces: [],
    pendingAgentRequests: 0,
    profileCount: 0,
    workspacesRoot: null,
  };
  sessionInfo.value = null;
  stop = startSession(
    { token: 't', launch: {}, route: '#/setup' },
    fake as unknown as typeof fetch,
  );
  root = document.createElement('div');
  document.body.append(root);
  act(() => render(<SetupScreen />, root));
  await flush();
});
afterEach(() => {
  act(() => render(null, root));
  root.remove();
  stop();
  overview.value = null;
  sessionInfo.value = null;
});

it('shows the four choices with what is done and what is next', () => {
  expect(root.querySelector('main')?.getAttribute('aria-label')).toBe('First run');
  expect(step('Create your key')?.className).toContain('step-done');
  expect(step('Where cloaks live')?.className).toContain('step-current');
  expect(step('Where cloaks live')?.textContent).toContain('Not chosen yet');
  expect(step('Never pull these')?.textContent).toContain('3 patterns · 2 presets on');
  expect(step('First profile')?.textContent).toContain('suggested: Contoso → ?, ContosoHealth → ?');
  expect(calls.find((call) => call.path === '/api/v2/setup')).toBeTruthy();
});

it('offers to create the key when there is none', async () => {
  act(() => render(null, root));
  state = { ...fresh, key: { exists: false, storage: null } };
  act(() => render(<SetupScreen />, root));
  await flush();
  expect(step('Create your key')?.textContent).toContain('No key yet');
  expect(step('Create your key')?.className).toContain('step-current');
  await act(async () => {
    button('Create key')?.click();
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(calls.filter((call) => call.method === 'PUT').at(-1)?.body).toEqual({
    presets: ['env', 'keys'],
  });
  expect(step('Create your key')?.className).toContain('step-done');
  expect(step('Create your key')?.textContent).toContain('key 3f9a…c21 · key file');
});

it('saves the cloak folder, and shows a refusal without closing the form', async () => {
  const section = step('Where cloaks live');
  act(() => button('Choose', section ?? root)?.click());
  failRoot = true;
  type(section?.querySelector('input'), '/repo/inside');
  await act(async () => {
    button('Save folder')?.click();
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(step('Where cloaks live')?.textContent).toContain('Inside a repository');
  failRoot = false;
  type(step('Where cloaks live')?.querySelector('input'), '/home/me/cloaks');
  await act(async () => {
    button('Save folder')?.click();
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(step('Where cloaks live')?.className).toContain('step-done');
  expect(step('Where cloaks live')?.textContent).toContain('/home/me/cloaks');
  expect(step('First profile')?.textContent).toContain('Contoso → ?');
});

it('reviews presets and saves only those left on', async () => {
  const section = step('Never pull these');
  act(() => button('Review', section ?? root)?.click());
  expect(step('Never pull these')?.textContent).toContain('.env.*');
  const boxes = step('Never pull these')?.querySelectorAll<HTMLInputElement>('input') ?? [];
  act(() => boxes[1]?.click());
  expect(step('Never pull these')?.textContent).toContain('2 patterns · 1 presets on');
  await act(async () => {
    button('Save exclusions')?.click();
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(calls.filter((call) => call.method === 'PUT').at(-1)?.body).toEqual({ presets: ['env'] });
  expect(step('Never pull these')?.className).toContain('step-done');
});

it('creates the first profile from the suggested names, leaving blanks out', async () => {
  act(() => button('Set up')?.click());
  const inputs = step('First profile')?.querySelectorAll<HTMLInputElement>('input') ?? [];
  type(inputs[0], 'contoso');
  type(step('First profile')?.querySelectorAll<HTMLInputElement>('input')[1], 'Acme');
  await act(async () => {
    button('Save profile')?.click();
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(
    calls.find((call) => call.method === 'POST' && call.path === '/api/v2/profiles')?.body,
  ).toEqual({
    scope: { kind: 'global' },
    document: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'contoso',
      rules: [{ id: 'name-1', type: 'literal', match: 'Contoso', replace: 'Acme' }],
    },
  });
  expect(step('First profile')?.className).toContain('step-done');
  expect(step('First profile')?.textContent).toContain('1 profile');
});

it('finishing saves the presets, so defaults nobody opened still apply', async () => {
  await act(async () => {
    button('Finish & cloak this worktree')?.click();
    await new Promise((done) => setTimeout(done, 30));
  });
  expect(calls.filter((call) => call.method === 'PUT').at(-1)?.body).toEqual({
    presets: ['env', 'keys'],
  });
  expect(location.hash).toBe('#/new');
});

it('can be skipped', () => {
  expect(root.querySelector<HTMLAnchorElement>('.setup-foot a')?.getAttribute('href')).toBe('#/');
});
