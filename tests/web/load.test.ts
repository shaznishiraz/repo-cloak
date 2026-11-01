// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { api, lockTab, startSession } from '../../src/web/shell/load.js';
import { loadError, locked, overview, sessionInfo } from '../../src/web/shell/state.js';

afterEach(() => {
  vi.unstubAllGlobals();
  locked.value = false;
  loadError.value = null;
  overview.value = null;
  sessionInfo.value = null;
});

it('locks a tab that has no token instead of calling the server', () => {
  const request = vi.fn<typeof fetch>();
  startSession({ token: null, launch: {}, route: '#/' }, request);
  expect(request).not.toHaveBeenCalled();
  expect(locked.value).toBe(true);
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

it('locks and forgets the token when any call is rejected as unauthorized', async () => {
  const request = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ error: 'Session token required' }), { status: 401 }),
  );
  sessionStorage.setItem('cloak-token', 'old');
  const stop = startSession({ token: 'old', launch: {}, route: '#/' }, request);
  await vi.waitFor(() => expect(locked.value).toBe(true));
  stop();
  expect(sessionStorage.getItem('cloak-token')).toBeNull();
});

it('does not lock on other failures', async () => {
  const request = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ error: 'Busy' }), { status: 500 }),
  );
  const stop = startSession({ token: 't', launch: {}, route: '#/' }, request);
  await vi.waitFor(() => expect(loadError.value).toBe('Busy'));
  stop();
  expect(locked.value).toBe(false);
});

it('locking revokes on the server with the session token', async () => {
  const request = vi.fn<typeof fetch>(async () => new Response('{}'));
  const stop = startSession({ token: 't', launch: {}, route: '#/' }, request);
  await lockTab();
  stop();
  const call = request.mock.calls.find(([url]) => url === '/api/v2/session/lock');
  expect(call?.[1]?.method).toBe('POST');
  expect(call?.[1]?.headers).toMatchObject({ Authorization: 'Bearer t' });
  expect(locked.value).toBe(true);
});
