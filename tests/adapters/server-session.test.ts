import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAgentStore } from '../../src/adapters/agent-store.js';
import { createDashboardServer } from '../../src/adapters/server.js';
import { createStore } from '../../src/adapters/store.js';
import { createDashboard } from '../../src/application/dashboard.js';

const minute = 60_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(autoLockMinutes?: number) {
  const root = await mkdtemp(join(tmpdir(), 'cloak session '));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = createStore(join(root, 'store'));
  const dashboard = createDashboard(store, root);
  if (autoLockMinutes) await dashboard.settings.saveSecurity({ autoLockMinutes });
  const clock = { now: 1_000_000 };
  const server = createDashboardServer(dashboard, 'test-token', root, {
    launcherKey: 'launcher-key',
    now: () => clock.now,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path: string, token = 'test-token') =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const post = (path: string, token = 'test-token') =>
    fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const launch = async () => {
    const response = await post('/launcher/v1/session', 'launcher-key');
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
  };
  return { root, store, dashboard, clock, base, get, post, launch };
}
const apiPaths = ['/api/v2/session', '/api/v2/overview', '/api/v2/settings', '/api/v2/folders'];

it('revocation answers 401 on every API path, including lock and activity', async () => {
  const { get, post } = await fixture();
  expect((await get('/api/v2/session')).status).toBe(200);
  const locked = await post('/api/v2/session/lock');
  expect(locked.status).toBe(200);
  expect(await locked.json()).toEqual({ locked: true });
  for (const path of apiPaths) expect((await get(path)).status).toBe(401);
  expect((await post('/api/v2/session/lock')).status).toBe(401);
  expect((await post('/api/v2/session/activity')).status).toBe(401);
});

it('lock and activity need the session token', async () => {
  const { post, get } = await fixture();
  expect((await post('/api/v2/session/lock', 'wrong')).status).toBe(401);
  expect((await post('/api/v2/session/activity', 'wrong')).status).toBe(401);
  expect((await post('/api/v2/session/lock', 'launcher-key')).status).toBe(401);
  expect((await get('/api/v2/session')).status).toBe(200);
});

it('refuses a foreign origin on the lock route without locking', async () => {
  const { base, get } = await fixture();
  const response = await fetch(`${base}/api/v2/session/lock`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', Origin: 'https://foreign.test' },
  });
  expect(response.status).toBe(403);
  expect((await get('/api/v2/session')).status).toBe(200);
});

it('a lock from one tab ends the session of every other tab', async () => {
  const { get, post, launch } = await fixture();
  const other = await launch();
  expect((await get('/api/v2/session', other)).status).toBe(200);
  await post('/api/v2/session/lock');
  expect((await get('/api/v2/session', other)).status).toBe(401);
});

it('the launcher route is direct-only, POST-only and needs the launcher key', async () => {
  const { base, get, post } = await fixture();
  const url = `${base}/launcher/v1/session`;
  const key = { Authorization: 'Bearer launcher-key' };
  const blocked = await fetch(url, {
    method: 'POST',
    headers: { ...key, Origin: base },
  });
  expect(blocked.status).toBe(403);
  expect((await fetch(url, { headers: key })).status).toBe(404);
  expect((await fetch(url, { method: 'POST' })).status).toBe(401);
  expect((await post('/launcher/v1/session', 'test-token')).status).toBe(401);
  expect((await get('/api/v2/session', 'launcher-key')).status).toBe(401);
});

it('a server without a launcher key issues no tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak no key '));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dashboard = createDashboard(createStore(join(root, 'store')), root);
  const server = createDashboardServer(dashboard, 'test-token', root);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const response = await fetch(`http://127.0.0.1:${address.port}/launcher/v1/session`, {
    method: 'POST',
    headers: { Authorization: 'Bearer undefined' },
  });
  expect(response.status).toBe(401);
});

it('relaunch after revocation issues a working token and leaves the old one dead', async () => {
  const { get, post, launch } = await fixture();
  await post('/api/v2/session/lock');
  const fresh = await launch();
  expect(fresh).toMatch(/^[a-f0-9]{64}$/);
  expect((await get('/api/v2/session', fresh)).status).toBe(200);
  expect((await get('/api/v2/session')).status).toBe(401);
  await post('/api/v2/session/lock', fresh);
  expect((await get('/api/v2/session', fresh)).status).toBe(401);
  expect((await get('/api/v2/session', await launch())).status).toBe(200);
});

it('expires a closed tab from the saved autoLockMinutes, with nobody asking', async () => {
  const { get, clock, launch } = await fixture(5);
  clock.now += 5 * minute;
  expect((await get('/api/v2/session')).status).toBe(401);
  const fresh = await launch();
  expect((await get('/api/v2/session', fresh)).status).toBe(200);
  expect((await get('/api/v2/session')).status).toBe(401);
});

it('polling alone does not keep a session alive; user activity does', async () => {
  const { get, post, clock } = await fixture(5);
  for (let tick = 0; tick < 4; tick++) {
    clock.now += minute;
    expect((await get('/api/v2/session')).status).toBe(200);
    expect((await get('/api/v2/overview')).status).toBe(200);
  }
  expect((await post('/api/v2/session/activity')).status).toBe(200);
  clock.now += 4 * minute;
  expect((await get('/api/v2/session')).status).toBe(200);
  clock.now += minute;
  expect((await get('/api/v2/session')).status).toBe(401);
});

it('activity after the limit does not rescue the session', async () => {
  const { post, get, clock } = await fixture(5);
  clock.now += 5 * minute;
  expect((await post('/api/v2/session/activity')).status).toBe(401);
  expect((await get('/api/v2/session')).status).toBe(401);
});

it('a mutating API call does not count as activity', async () => {
  const { base, get, clock } = await fixture(5);
  clock.now += 4 * minute;
  const saved = await fetch(`${base}/api/v2/settings`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowExclusionOverride: false }),
  });
  expect(saved.status).toBe(200);
  clock.now += minute;
  expect((await get('/api/v2/session')).status).toBe(401);
});

it('a limit saved through Settings applies at once, without expiring the saver', async () => {
  const { base, get, clock } = await fixture();
  clock.now += 600 * minute;
  expect((await get('/api/v2/session')).status).toBe(200);
  const saved = await fetch(`${base}/api/v2/settings`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ autoLockMinutes: 5 }),
  });
  expect(saved.status).toBe(200);
  expect((await get('/api/v2/session')).status).toBe(200);
  clock.now += 5 * minute;
  expect((await get('/api/v2/session')).status).toBe(401);
});

it('never expires when no limit is set', async () => {
  const { get, clock } = await fixture();
  clock.now += 100_000 * minute;
  expect((await get('/api/v2/session')).status).toBe(200);
});

it('agent credentials keep working after a lock and an expiry, and are not activity', async () => {
  const { base, store, root, post, get, clock, launch } = await fixture(5);
  await createAgentStore(store).ensure({
    workspaceId: 'workspace-1',
    repoId: 'a'.repeat(16),
    path: root,
    worktree: root,
  });
  const credential = (await readFile(join(root, '.repo-cloak/agent/token'), 'utf8')).trim();
  const agentInfo = () =>
    fetch(`${base}/agent/v1/info`, { headers: { Authorization: `Bearer ${credential}` } });
  expect((await agentInfo()).status).toBe(200);
  clock.now += 4 * minute;
  expect((await agentInfo()).status).toBe(200);
  clock.now += minute;
  // Agent calls did not hold the session open, and its expiry does not touch them.
  expect((await get('/api/v2/session')).status).toBe(401);
  expect((await agentInfo()).status).toBe(200);
  // An explicit lock of a fresh session does not touch them either.
  const fresh = await launch();
  expect((await post('/api/v2/session/lock', fresh)).status).toBe(200);
  expect((await agentInfo()).status).toBe(200);
  // The two kinds of credential stay apart in both directions.
  expect((await get('/api/v2/session', credential)).status).toBe(401);
  expect(
    (await fetch(`${base}/agent/v1/info`, { headers: { Authorization: `Bearer ${fresh}` } }))
      .status,
  ).toBe(401);
});

function prepared(apply: () => Promise<unknown>) {
  return {
    bytes: 0,
    summary: {
      direction: 'pull',
      writes: [],
      deletes: [],
      conflicts: [],
      warnings: [],
      profileChanges: [],
      canApply: true,
      forced: false,
    },
    apply,
  } as never;
}

function deferred() {
  let resolve: (value: unknown) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<unknown>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it('a running sync finishes through a lock, and a new session can read its result', async () => {
  const { dashboard, base, get, post, launch } = await fixture();
  const gate = deferred();
  const { operationId } = await dashboard.sync.operations.preview(async () =>
    prepared(() => gate.promise),
  );
  const applied = await fetch(`${base}/api/v2/operations/${operationId}/apply`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(((await applied.json()) as { state: string }).state).toBe('running');
  await post('/api/v2/session/lock');
  expect((await get(`/api/v2/operations/${operationId}`)).status).toBe(401);
  gate.resolve({ done: true });
  await dashboard.sync.operations.wait(operationId);
  const read = await get(`/api/v2/operations/${operationId}`, await launch());
  expect(await read.json()).toMatchObject({ state: 'completed', result: { done: true } });
});

it('a running sync that fails through a lock reports the failure afterwards', async () => {
  const { dashboard, base, get, post, launch } = await fixture();
  const gate = deferred();
  const { operationId } = await dashboard.sync.operations.preview(async () =>
    prepared(() => gate.promise),
  );
  await fetch(`${base}/api/v2/operations/${operationId}/apply`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: '{}',
  });
  await post('/api/v2/session/lock');
  gate.reject(new Error('disk full'));
  await dashboard.sync.operations.wait(operationId);
  const read = await get(`/api/v2/operations/${operationId}`, await launch());
  expect(await read.json()).toMatchObject({ state: 'failed', error: 'disk full', code: 'write' });
});

it('a running sync outlives idle expiry; the sync slot is free afterwards', async () => {
  const { dashboard, base, get, clock, launch } = await fixture(5);
  const gate = deferred();
  const { operationId } = await dashboard.sync.operations.preview(async () =>
    prepared(() => gate.promise),
  );
  await fetch(`${base}/api/v2/operations/${operationId}/apply`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: '{}',
  });
  clock.now += 6 * minute;
  expect((await get('/api/v2/session')).status).toBe(401);
  gate.resolve({ done: true });
  await dashboard.sync.operations.wait(operationId);
  await expect(dashboard.sync.operations.exclusive(async () => 'free')).resolves.toBe('free');
  const read = await get(`/api/v2/operations/${operationId}`, await launch());
  expect(await read.json()).toMatchObject({ state: 'completed' });
});

it('a locked token cannot start a pending sync', async () => {
  const { dashboard, base, post, launch, get } = await fixture();
  let ran = false;
  const { operationId } = await dashboard.sync.operations.preview(async () =>
    prepared(async () => {
      ran = true;
    }),
  );
  await post('/api/v2/session/lock');
  const refused = await fetch(`${base}/api/v2/operations/${operationId}/apply`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(refused.status).toBe(401);
  expect(ran).toBe(false);
  const read = await get(`/api/v2/operations/${operationId}`, await launch());
  expect(await read.json()).toMatchObject({ state: 'pending' });
});
