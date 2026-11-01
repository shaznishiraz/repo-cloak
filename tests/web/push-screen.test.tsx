// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  DiffLine,
  Overview,
  OverviewWorkspace,
  PushFile,
  PushReview,
} from '../../src/web/api/contracts.js';
import { ApiError } from '../../src/web/api/client.js';
import { splitHunks, targetOptions } from '../../src/web/screens/push/model.js';
import { commands } from '../../src/web/shell/commands.js';
import { overview } from '../../src/web/shell/state.js';
import { toasts } from '../../src/web/shell/ui/index.js';

const call = vi.fn<(route: string, options?: unknown) => Promise<unknown>>();
const client = { call };
vi.mock('../../src/web/shell/load.js', () => ({ api: () => client }));
const { PushScreen } = await import('../../src/web/screens/push/index.js');

const workspace: OverviewWorkspace = {
  id: 'w1',
  repoId: 'r',
  name: 'northwind-api-7c1e',
  path: '/c/northwind',
  groupId: 'g1',
  state: 'to-push',
  counts: { tracked: 9, modified: 2, added: 1, deleted: 0 },
  sourceMoved: false,
  lineage: {
    repo: { id: 'r', name: 'api', path: '/x/api' },
    worktree: { path: '/x/api/.worktrees/claims', branch: 'feat/claims', sha: 'abc' },
    cloak: { id: 'w1', name: 'northwind-api-7c1e', path: '/c/northwind' },
  },
  pendingRequests: 0,
  lastUsedAt: '2026-01-01T00:00:00Z',
  lastPullAt: null,
};
const data: Overview = {
  launch: { kind: 'none' },
  repos: [],
  groups: [{ id: 'g1', name: 'claims', workspaceCount: 2 }],
  workspaces: [{ ...workspace }, { ...workspace, id: 'w2', name: 'northwind-web' }],
  pendingAgentRequests: 0,
  profileCount: 1,
  workspacesRoot: null,
};
const file = (over: Partial<PushFile> = {}): PushFile => ({
  path: 'src/Northwind.cs',
  restoredPath: 'src/Acme.cs',
  status: 'modified',
  additions: 3,
  deletions: 1,
  flags: ['clean'],
  ...over,
});
const reviewOf = (over: Partial<PushReview> = {}): PushReview => ({
  target: { kind: 'origin' },
  files: [
    file(),
    file({
      path: 'NorthwindJob.cs',
      restoredPath: 'AcmeJob.cs',
      status: 'added',
      flags: ['clean', 'new-derived-name'],
    }),
  ],
  checks: [
    { id: 'restores', state: 'ok', title: 'Every cloaked name restores', detail: '2 rules' },
    { id: 'no-leak', state: 'ok', title: 'No cloaked name leaks into source' },
    { id: 'merges', state: 'ok', title: 'No upstream changes to merge' },
    { id: 'manifest', state: 'ok', title: 'Only files from this cloak' },
    { id: 'target', state: 'info', title: 'target is clean', detail: 'HEAD a41d2b7' },
  ],
  derivedNames: [{ cloaked: 'NorthwindJob', restored: 'AcmeJob' }],
  operationId: 'op-1',
  canApply: true,
  ...over,
});
const diff: DiffLine[] = [
  { kind: 'context', line: 4, cloaked: 'namespace Northwind;', restored: 'namespace Acme;' },
  { kind: 'remove', line: 5, cloaked: 'old Northwind', restored: 'old Acme' },
  { kind: 'add', line: 5, cloaked: 'new Northwind', restored: 'new Acme' },
  { kind: 'context', line: 40, cloaked: 'far', restored: 'far' },
];

let root: HTMLElement;
let review: PushReview;
let reviews: { target: unknown }[];
let applied: Record<string, unknown>[];
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  overview.value = data;
  toasts.value = [];
  review = reviewOf();
  reviews = [];
  applied = [];
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  call.mockReset();
  call.mockImplementation(async (route, options) => {
    const body = (options as { body?: unknown } | undefined)?.body;
    switch (route) {
      case 'GET /api/v2/worktrees/:repoId':
        return {
          worktrees: [
            { path: '/x/api', branch: 'main' },
            { path: '/x/api/.worktrees/claims', branch: 'feat/claims' },
            { path: '/x/api/.worktrees/hotfix', branch: 'release/4.2' },
          ],
        };
      case 'GET /api/v2/push/:repoId/:id/backups':
        return { backups: [] };
      case 'POST /api/v2/push/:repoId/:id/review':
        reviews.push(body as { target: unknown });
        return review;
      case 'GET /api/v2/push/:repoId/:id/diff':
        return { lines: diff };
      case 'POST /api/v2/push/:repoId/:id/apply':
        applied.push(body as Record<string, unknown>);
        return {
          operationId: 'op-1',
          state: 'completed',
          expiresAt: '',
          result: {
            status: 'written',
            workspace: '/c',
            workspaceId: 'w1',
            writes: ['src/Acme.cs', 'AcmeJob.cs'],
            deletes: [],
            replacements: 2,
            skipped: 0,
            warnings: ['Committed abc123'],
            profileChanges: [],
          },
        };
      default:
        throw new Error(`Unexpected ${route}`);
    }
  });
});
afterEach(() => {
  act(() => render(null, root));
  root.remove();
  overview.value = null;
});
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
  });
}
async function show() {
  await act(() => render(<PushScreen workspaceId="w1" />, root));
  await settle();
}
const button = (name: string | RegExp) =>
  [...root.querySelectorAll('button')].find((item) =>
    typeof name === 'string' ? item.textContent === name : name.test(item.textContent ?? ''),
  );
const pushButton = () => button(/^Push \d+ files? to|^Pushing/);
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(() => (element as HTMLElement).click());
  await settle();
};

it('renders the target, file flags, the diff columns and the checks', async () => {
  await show();
  expect(reviews[0]).toEqual({ target: { kind: 'origin' } });
  const select = root.querySelector('select');
  expect(select?.options[0]?.textContent).toBe('.worktrees/claims · feat/claims (pulled from)');
  expect([...(select?.options ?? [])].map((item) => item.textContent)).toEqual(
    expect.arrayContaining([
      'api · main checkout',
      '.worktrees/hotfix · release/4.2',
      'new worktree from main…',
    ]),
  );
  expect(root.textContent).toContain('cloak · 2 changes');
  expect(root.textContent).toContain('target is clean · HEAD a41d2b7');
  const rows = root.querySelectorAll('.push-files .row');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('+3 −1 · clean');
  expect(rows[1]?.textContent).toContain('+3 −1 · ! new name derived');
  expect(root.textContent).toContain('What Claude edited · cloak');
  expect(root.textContent).toContain('What lands in source · restored');
  expect(root.textContent).toContain('new Northwind');
  expect(root.textContent).toContain('new Acme');
  expect(root.textContent).toContain('hunk 1 of 2');
  for (const title of [
    'Every cloaked name restores',
    'No cloaked name leaks into source',
    'Only files from this cloak',
  ])
    expect(root.querySelector('.push-aside')?.textContent).toContain(title);
  // The target line lives in the header rather than repeating in the checks.
  expect(root.querySelector('.push-aside')?.textContent).not.toContain('target is clean');
  expect(root.querySelector('.push-names')?.textContent).toContain('NorthwindJob→AcmeJob');
  expect(pushButton()?.textContent).toBe('Push 2 files to claims');
});

it('switches to the restored diff only', async () => {
  await show();
  await click(root.querySelector('[data-tab="restored"]'));
  expect(root.textContent).toContain('new Acme');
  expect(root.querySelector('.push-lines')?.textContent).not.toContain('new Northwind');
  expect(root.textContent).not.toContain('What Claude edited');
});

it('fetches the diff for the selected file', async () => {
  await show();
  await click(root.querySelectorAll('.push-files .row')[1]);
  expect(call).toHaveBeenCalledWith(
    'GET /api/v2/push/:repoId/:id/diff',
    expect.objectContaining({ query: { path: 'NorthwindJob.cs' } }),
  );
});

it('reviews again when the target changes, and treats a dry run as read-only', async () => {
  await show();
  const select = root.querySelector('select') as HTMLSelectElement;
  review = reviewOf({ target: { kind: 'dry-run' }, operationId: null, canApply: false });
  await act(() => {
    select.value = 'dry-run';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  expect(reviews.at(-1)).toEqual({ target: { kind: 'dry-run' } });
  expect(pushButton()?.disabled).toBe(true);
  expect(root.textContent).toContain('Dry run: nothing will be written');
});

it('asks for a branch before reviewing a new worktree', async () => {
  await show();
  const select = root.querySelector('select') as HTMLSelectElement;
  await act(() => {
    select.value = 'new';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  expect(reviews).toHaveLength(1);
  const input = [...root.querySelectorAll('dialog input')].at(-1) as HTMLInputElement;
  expect(button('Review')?.disabled).toBe(true);
  await act(() => {
    input.value = 'feature/new';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(button('Review'));
  expect(reviews.at(-1)).toEqual({ target: { kind: 'new-worktree', branch: 'feature/new' } });
  expect(pushButton()?.textContent).toBe('Push 2 files to feature/new');
});

it('sends the chosen mode, message and options, then reports warnings', async () => {
  await show();
  const radios = root.querySelectorAll<HTMLInputElement>('input[type="radio"]');
  expect(radios[1]?.checked).toBe(true);
  await click(radios[2]);
  expect(pushButton()?.disabled).toBe(true);
  expect(root.textContent).toContain('Enter a commit message');
  const message = root.querySelector('.push-aside input[type="text"]') as HTMLInputElement;
  await act(() => {
    message.value = 'Add NorthwindJob';
    message.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const boxes = root.querySelectorAll<HTMLInputElement>('.push-aside input[type="checkbox"]');
  expect(boxes[0]?.parentElement?.textContent).toBe('Re-pull these 2 files after push');
  expect(boxes[1]?.parentElement?.textContent).toBe('Also push northwind-web (group claims)');
  await click(boxes[1]);
  await click(pushButton());
  expect(applied).toEqual([
    {
      operationId: 'op-1',
      mode: 'commit',
      commitMessage: 'Add NorthwindJob',
      repull: true,
      includeGroupMembers: true,
      mergeMode: 'merge',
    },
  ]);
  expect(root.querySelector('.push-result')?.textContent).toContain('Pushed 2 files');
  expect(root.querySelector('.push-result')?.textContent).toContain('Committed abc123');
  expect(toasts.value[0]?.tone).toBe('ok');
  expect(reviews).toHaveLength(2);
});

it('polls a running push through the shared operation route', async () => {
  const states = [
    { operationId: 'op-1', state: 'running', expiresAt: '' },
    { operationId: 'op-1', state: 'failed', expiresAt: '', code: 'stale', error: 'moved' },
  ];
  const base = call.getMockImplementation();
  call.mockImplementation(async (route, options) => {
    if (route === 'POST /api/v2/push/:repoId/:id/apply') return states[0];
    if (route === 'GET /api/v2/operations/:id') return states[1];
    return base?.(route, options);
  });
  await show();
  await click(pushButton());
  await act(() => new Promise((done) => setTimeout(done, 500)));
  await settle();
  expect(root.querySelector('[role="alert"]')?.textContent).toContain(
    'Files changed after this review',
  );
  expect(reviews).toHaveLength(2);
});

it('shows a stale review without pretending anything was written', async () => {
  const base = call.getMockImplementation();
  call.mockImplementation(async (route, options) => {
    if (route === 'POST /api/v2/push/:repoId/:id/apply') throw new ApiError(404, 'gone', 'unknown');
    return base?.(route, options);
  });
  await show();
  await click(pushButton());
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('nothing was written');
  expect(root.querySelector('.push-result')).toBeNull();
});

it('merges by default and needs a confirmed choice to overwrite', async () => {
  review = reviewOf({
    files: [file({ flags: ['source-moved', 'conflict'] })],
    derivedNames: [],
    checks: [
      { id: 'merges', state: 'blocked', title: '1 file overlaps' },
      {
        id: 'merge:src/Northwind.cs',
        state: 'blocked',
        title: 'Acme.cs changed in the source after you pulled',
        detail: 'Upstream commit c33e8f1 touched line 5.',
      },
    ],
  });
  await show();
  expect(root.querySelector('.push-note')?.textContent).toContain('c33e8f1');
  expect(root.querySelector('.push-files')?.textContent).toContain('↓ source moved · overlaps');
  expect(button('Merge (recommended)')?.disabled).toBe(true);
  expect(pushButton()?.disabled).toBe(true);
  expect(root.textContent).toContain('Pull first, or choose to overwrite');
  const pull = [...root.querySelectorAll('.push-note a')].find(
    (link) => link.textContent === 'Pull first',
  );
  expect(pull?.getAttribute('href')).toBe('#/ws/w1');
  await click(button('Overwrite'));
  expect(pushButton()?.disabled).toBe(true);
  await click(button('Overwrite source files'));
  expect(pushButton()?.disabled).toBe(false);
  await click(pushButton());
  expect(applied[0]?.mergeMode).toBe('overwrite');
});

it('lets a clean auto-merge through as a merge', async () => {
  review = reviewOf({
    files: [file({ flags: ['source-moved', 'auto-merge'] })],
    checks: [
      {
        id: 'merge:src/Northwind.cs',
        state: 'info',
        title: 'Acme.cs changed in the source after you pulled',
        detail: 'A 3-way merge applies cleanly.',
      },
    ],
  });
  await show();
  expect(root.querySelector('.push-files')?.textContent).toContain('auto-merge');
  expect(button('Merge (recommended)')?.getAttribute('aria-pressed')).toBe('true');
  await click(pushButton());
  expect(applied[0]?.mergeMode).toBe('merge');
});

it('confirms deletions by listing them first', async () => {
  review = reviewOf({ files: [file({ status: 'deleted', additions: 0 })] });
  await show();
  await click(pushButton());
  expect(applied).toEqual([]);
  expect(root.textContent).toContain('Delete 1 file from the source?');
  await click(button('Delete and push'));
  expect(applied).toHaveLength(1);
});

it('blocks the push when a guard check fails', async () => {
  review = reviewOf({
    operationId: null,
    canApply: false,
    checks: [
      { id: 'no-leak', state: 'blocked', title: 'A cloaked name would leak', detail: 'a.ts:1:2' },
    ],
  });
  await show();
  expect(pushButton()?.disabled).toBe(true);
  expect(root.querySelector('[data-check="no-leak"]')?.textContent).toContain('blocked:');
  expect(root.textContent).toContain('Fix the blocked checks first');
});

it('offers undo from the latest backup and reviews again afterwards', async () => {
  const base = call.getMockImplementation();
  const undo = vi.fn(() => ({ restored: 3 }));
  call.mockImplementation(async (route, options) => {
    if (route === 'GET /api/v2/push/:repoId/:id/backups')
      return {
        backups: [{ id: 'b1', createdAt: '2026-01-01', expiresAt: '2026-01-08', files: 3 }],
      };
    if (route === 'POST /api/v2/push/:repoId/:id/backups/:backupId/undo') return undo();
    return base?.(route, options);
  });
  await show();
  expect(root.querySelector('.push-backup')?.textContent).toContain('kept for 7 days');
  await click(button('undo'));
  expect(undo).not.toHaveBeenCalled();
  expect(root.textContent).toContain('A commit made by that push stays in history');
  await click(button('Restore from backup'));
  expect(call).toHaveBeenCalledWith(
    'POST /api/v2/push/:repoId/:id/backups/:backupId/undo',
    expect.objectContaining({ params: { repoId: 'r', id: 'w1', backupId: 'b1' } }),
  );
  expect(reviews).toHaveLength(2);
  expect(toasts.value[0]?.message).toBe('Restored 3 files from the backup');
});

it('hides the undo link with no backup and the group option outside a group', async () => {
  overview.value = {
    ...data,
    workspaces: [{ ...workspace, groupId: null }],
  };
  await show();
  expect(button('undo')).toBeUndefined();
  expect(root.textContent).not.toContain('Also push');
});

it('still works when the worktree list is not available', async () => {
  const base = call.getMockImplementation();
  call.mockImplementation(async (route, options) => {
    if (route === 'GET /api/v2/worktrees/:repoId') throw new ApiError(404, 'Not found');
    return base?.(route, options);
  });
  await show();
  expect(root.querySelector('select')?.options.length).toBeGreaterThan(2);
  expect(pushButton()?.disabled).toBe(false);
});

it('shows empty, unknown and failed states', async () => {
  review = reviewOf({ files: [], operationId: null, canApply: false, derivedNames: [] });
  await show();
  expect(root.textContent).toContain('Nothing to push');
  render(null, root);

  const base = call.getMockImplementation();
  call.mockImplementation(async (route, options) => {
    if (route === 'POST /api/v2/push/:repoId/:id/review')
      throw new ApiError(400, 'Select a worktree belonging to this repository');
    return base?.(route, options);
  });
  await show();
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('Select a worktree');
  render(null, root);

  await act(() => render(<PushScreen workspaceId="missing" />, root));
  await settle();
  expect(root.textContent).toContain('Workspace not found');
});

it('registers palette commands while it is on screen', async () => {
  await show();
  const titles = commands.value.map((command) => command.title);
  // A later review changes the title the palette shows.
  expect(titles).toEqual(
    expect.arrayContaining(['Push 2 files to claims', 'Review this push again']),
  );
  commands.value.find((command) => command.id === 'push.mode')?.run();
  await settle();
  expect(root.querySelector('.push-lines-single')).toBeTruthy();
  await act(() => render(null, root));
  await settle();
  expect(commands.value.some((command) => command.id === 'push.go')).toBe(false);
});

it('groups diff lines into hunks by line jumps', () => {
  expect(splitHunks(diff).map((hunk) => hunk.length)).toEqual([3, 1]);
  expect(splitHunks([])).toEqual([]);
});

it('leaves the main option out when the cloak was pulled from the main checkout', () => {
  const options = targetOptions(
    {
      ...workspace,
      lineage: {
        ...workspace.lineage,
        worktree: { path: '/x/api', branch: 'main', sha: 'a' },
      },
    },
    [{ path: '/x/api', branch: 'main' }],
  );
  expect(options.map((item) => item.value)).toEqual(['origin', 'new', 'dry-run']);
  expect(options[0]?.label).toBe('api · main (pulled from)');
});
