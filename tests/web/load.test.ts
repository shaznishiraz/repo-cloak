import { afterEach, expect, it, vi } from 'vitest';
import { api, startSession } from '../../src/web/shell/load.js';
import { loadError, overview, sessionInfo } from '../../src/web/shell/state.js';

afterEach(() => {
  loadError.value = null;
  overview.value = null;
  sessionInfo.value = null;
});

it('explains a tab that has no token instead of calling the server', () => {
  const request = vi.fn<typeof fetch>();
  startSession({ token: null, launch: {}, route: '#/' }, request);
  expect(request).not.toHaveBeenCalled();
  expect(loadError.value).toMatch(/link printed by repo-cloak/);
});

it('loads session and overview with the launch context', async () => {
  const request = vi.fn<typeof fetch>(
    async (url) =>
      new Response(
        JSON.stringify(String(url).includes('session') ? { version: '2' } : { repos: [] }),
      ),
  );
  const stop = startSession(
    { token: 't', launch: { repo: 'r', worktree: '/w' }, route: '#/' },
    request,
  );
  await vi.waitFor(() => expect(overview.value).not.toBeNull());
  stop();
  expect(sessionInfo.value).toEqual({ version: '2' });
  expect(request.mock.calls.map((call) => call[0])).toContain(
    '/api/v2/overview?repo=r&worktree=%2Fw',
  );
  expect(api()).toBeDefined();
});

it('tells the user to relaunch when the token is rejected', async () => {
  const request = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ error: 'Session token required' }), { status: 401 }),
  );
  const stop = startSession({ token: 'old', launch: {}, route: '#/' }, request);
  await vi.waitFor(() => expect(loadError.value).toMatch(/Run repo-cloak again/));
  stop();
});
