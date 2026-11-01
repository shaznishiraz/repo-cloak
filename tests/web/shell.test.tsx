// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Overview, SessionInfo } from '../../src/web/api/contracts.js';
import { registerShellCommands } from '../../src/web/shell/nav-commands.js';
import { paletteOpen } from '../../src/web/shell/palette.js';
import { parseRoute, route, startRouter } from '../../src/web/shell/router.js';
import { Shell } from '../../src/web/shell/shell.js';
import { overview, sessionInfo } from '../../src/web/shell/state.js';

const data: Overview = {
  launch: {
    kind: 'repo',
    repoId: 'r',
    label: 'api/.worktrees/claims',
    path: '/x',
    branch: 'feat/x',
  },
  repos: [{ id: 'r', name: 'api', path: '/x', missing: false, workspaceCount: 2 }],
  groups: [{ id: 'g1', name: 'claims', workspaceCount: 1 }],
  workspaces: [
    {
      id: 'w1',
      repoId: 'r',
      name: 'acme-api-7c1e',
      path: '/c/acme',
      groupId: 'g1',
      state: 'to-push',
      counts: { tracked: 9, modified: 2, added: 1, deleted: 0 },
      sourceMoved: false,
      lineage: {
        repo: { id: 'r', name: 'api', path: '/x' },
        worktree: { path: '/x', branch: 'feat/x', sha: 'abc' },
        cloak: { id: 'w1', name: 'acme-api-7c1e', path: '/c/acme' },
      },
      pendingRequests: 3,
      lastUsedAt: '2026-01-01T00:00:00Z',
      lastPullAt: null,
    },
  ],
  pendingAgentRequests: 3,
  profileCount: 4,
  workspacesRoot: '/c',
};
const info: SessionInfo = {
  app: 'repo-cloak',
  protocol: 1,
  version: '2.0.0',
  ui: 'next',
  port: 4000,
  store: {
    sealed: true,
    keyId: 'k_3f9a00000000',
    storage: 'file',
    migrationAvailable: false,
    rotationPending: false,
  },
  policy: { status: 'none', locked: [] },
  auditFailures: 0,
};

let root: HTMLElement;
let cleanups: (() => void)[];
beforeEach(() => {
  location.hash = '';
  root = document.createElement('div');
  document.body.append(root);
  overview.value = data;
  sessionInfo.value = info;
  cleanups = [registerShellCommands(), startRouter()];
  act(() => render(<Shell />, root));
});
afterEach(() => {
  act(() => {
    render(null, root);
    paletteOpen.value = false;
  });
  root.remove();
  for (const cleanup of cleanups) cleanup();
});
function link(name: string) {
  return [...root.querySelectorAll('a')].find((a) => a.textContent?.includes(name));
}
const key = (init: KeyboardEventInit, target: EventTarget = window) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });

it.each([
  ['#/', 'Workspaces', '10-home'],
  ['#/new', 'New cloak', '20-new-cloak'],
  ['#/ws/w1', 'Workspaces', '10-home'],
  ['#/ws/w1/push', 'Push review', '30-push'],
  ['#/groups/g1', 'Group sync', '10-home'],
  ['#/repos', 'Known repos', '50-admin'],
  ['#/requests', 'Agent requests', '50-admin'],
  ['#/profiles', 'Profiles', '40-profiles'],
  ['#/profiles/p1', 'Profiles', '40-profiles'],
  ['#/profiles/p1/json', 'Profiles', '40-profiles'],
  ['#/history', 'History', '50-admin'],
  ['#/settings', 'Settings', '50-admin'],
  ['#/setup', 'First run', '20-new-cloak'],
])('renders the %s placeholder', (hash, title, owner) => {
  act(() => {
    route.value = parseRoute(hash);
  });
  const screen = root.querySelector('main');
  expect(screen?.getAttribute('aria-label')).toBe(title);
  expect(screen?.getAttribute('data-placeholder')).toBe(owner);
});

it('renders a recovery page for unknown routes', () => {
  act(() => {
    route.value = parseRoute('#/nope');
  });
  expect(root.querySelector('main')?.textContent).toContain('Page not found');
});

it('shows real counts, launch context and the sealed store in the chrome', () => {
  expect(link('Workspaces')?.textContent).toContain('1');
  expect(link('Known repos')?.textContent).toContain('1');
  expect(link('Agent requests')?.textContent).toContain('3');
  expect(link('Profiles')?.textContent).toContain('4');
  expect(link('claims')?.getAttribute('href')).toBe('#/groups/g1');
  expect(root.querySelector('.launch-chip')?.textContent).toContain('api/.worktrees/claims');
  expect(root.querySelector('.launch-branch')?.textContent).toBe('feat/x');
  expect(root.querySelector('.store-chip')?.textContent).toContain('key 3f9a');
  expect(root.textContent).toContain('v2.0.0');
  expect(root.textContent).toContain('/c · 1 workspace');
  expect(root.textContent).toContain('ui 127.0.0.1:4000');
});

it('marks the current page in the rail', () => {
  act(() => {
    route.value = parseRoute('#/settings');
  });
  expect(link('Settings')?.getAttribute('aria-current')).toBe('page');
  expect(link('Workspaces')?.hasAttribute('aria-current')).toBe(false);
});

it('opens the palette with ⌘K, navigates with the keyboard, and closes', async () => {
  key({ key: 'k', metaKey: true });
  const dialog = root.querySelector<HTMLDialogElement>('dialog.palette');
  expect(dialog?.open).toBe(true);
  const input = dialog?.querySelector('input');
  act(() => {
    if (!input) return;
    input.value = 'known';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(dialog?.querySelector('[aria-selected="true"]')?.textContent).toContain('Known repos');
  key({ key: 'Enter' }, input as EventTarget);
  expect(paletteOpen.value).toBe(false);
  expect(dialog?.open).toBe(false);
  await vi.waitFor(() => expect(location.hash).toBe('#/repos'));
  await vi.waitFor(() => expect(route.value.screen).toBe('repos'));
});

it('lists workspaces and pending pushes in the palette and moves with arrows', () => {
  act(() => {
    paletteOpen.value = true;
  });
  const dialog = root.querySelector('dialog.palette');
  const options = () => [...(dialog?.querySelectorAll('[role="option"]') ?? [])];
  expect(options()[0]?.textContent).toContain('Push acme-api-7c1e');
  expect(options().some((option) => option.textContent?.includes('/c/acme'))).toBe(true);
  key({ key: 'ArrowDown' }, dialog as EventTarget);
  expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
  key({ key: 'ArrowUp' }, dialog as EventTarget);
  key({ key: 'ArrowUp' }, dialog as EventTarget);
  expect(options().at(-1)?.getAttribute('aria-selected')).toBe('true');
});

it('toggles the palette from the search button and with Ctrl+K', () => {
  act(() => root.querySelector<HTMLButtonElement>('button.search')?.click());
  expect(paletteOpen.value).toBe(true);
  key({ key: 'k', ctrlKey: true });
  expect(paletteOpen.value).toBe(false);
});

it('opens New cloak with N but never while typing', async () => {
  const field = document.createElement('input');
  document.body.append(field);
  key({ key: 'n' }, field);
  expect(location.hash).not.toBe('#/new');
  field.remove();
  key({ key: 'n' });
  await vi.waitFor(() => expect(location.hash).toBe('#/new'));
});
