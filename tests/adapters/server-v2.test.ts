import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RequestError, matchRoute, route } from '../../src/adapters/server-v2/router.js';
import { v2Routes } from '../../src/adapters/server-v2/index.js';
import { createDashboardServer } from '../../src/adapters/server.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { createTestSync } from '../support/sync.js';
import type { Overview, SessionInfo } from '../../src/web/api/contracts.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak v2 ')));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, 'source');
  await mkdir(source);
  const store = createStore(join(root, 'store'));
  const services = createSyncServices(source, store);
  await services.git.runGit(source, ['init', '-b', 'main']);
  const dashboard = createDashboard(store, source);
  const server = createDashboardServer(dashboard, 'test-token', resolve('src/ui'), 'next');
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
  return { root, source, store, services, dashboard, address, base, get };
}

it('matches routes by method and decodes parameters', () => {
  const routes = [route('GET /api/v2/workspaces/:repoId/:id', () => ({}) as never)];
  expect(matchRoute(routes, 'GET', '/api/v2/workspaces/r/a%2Fb')?.params).toEqual({
    repoId: 'r',
    id: 'a/b',
  });
  expect(matchRoute(routes, 'POST', '/api/v2/workspaces/r/a')).toBeUndefined();
  expect(matchRoute(routes, 'GET', '/api/v2/workspaces/r')).toBeUndefined();
  expect(matchRoute(routes, 'GET', '/api/v2/workspaces//a')).toBeUndefined();
  expect(() => matchRoute(routes, 'GET', '/api/v2/workspaces/%E0%A4%A/a')).toThrow(RequestError);
});

it('keeps the token and origin checks in front of every v2 route', async () => {
  const { base, get, address } = await fixture();
  expect(v2Routes.map((item) => item.path)).toEqual(
    expect.arrayContaining(['/api/v2/session', '/api/v2/overview']),
  );
  for (const path of ['/api/v2/session', '/api/v2/overview', '/api/v2/anything']) {
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    expect((await get(path, 'wrong-token')).status).toBe(401);
    const foreign = await fetch(`${base}${path}`, {
      headers: { Authorization: 'Bearer test-token', Origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
  }
  const status = await new Promise<number | undefined>((done, fail) => {
    const call = request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/api/v2/session',
        headers: { Host: 'evil.example', Authorization: 'Bearer test-token' },
      },
      (response) => {
        response.resume();
        done(response.statusCode);
      },
    );
    call.on('error', fail);
    call.end();
  });
  expect(status).toBe(403);
  const unknown = await get('/api/v2/anything');
  expect(unknown.status).toBe(404);
  expect(unknown.headers.get('content-security-policy')).toContain("default-src 'self'");
});

it('reports the session, UI kind and whether the store is sealed', async () => {
  const { get, address, dashboard } = await fixture();
  const fresh = (await (await get('/api/v2/session')).json()) as SessionInfo;
  expect(fresh).toMatchObject({ app: 'repo-cloak', ui: 'next', port: address.port });
  expect(fresh.store.sealed).toBe(false);
  await dashboard.context();
  const sealed = (await (await get('/api/v2/session')).json()) as SessionInfo;
  expect(sealed.store).toMatchObject({ sealed: true, storage: 'file' });
  expect(sealed.store.keyId).toMatch(/^k_/);
});

it('returns real counts, lineage and launch context from the overview', async () => {
  const { root, source, services, dashboard, get } = await fixture();
  await writeFile(join(source, 'Acme.ts'), 'class Acme {}');
  await writeFile(join(source, 'Other.ts'), 'class Other {}');
  await services.git.runGit(source, ['add', '-A']);
  await services.git.runGit(source, [
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-qm',
    'first',
  ]);
  const context = await dashboard.context();
  const repoId = context.repoId as string;
  await dashboard.saveProfile({
    scope: { kind: 'repo', repoId },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'names',
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    },
  });
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  const workspace = join(root, 'workspace');
  const pulled = await createTestSync(services, '2.0.0')('push', {
    profiles: ['names'],
    files: ['Acme.ts', 'Other.ts'],
    to: workspace,
  });
  await writeFile(join(workspace, 'Other.ts'), 'class Changed {}');
  await writeFile(join(workspace, 'New.ts'), 'class New {}');

  const query = new URLSearchParams({ repo: repoId, worktree: source });
  const data = (await (await get(`/api/v2/overview?${query}`)).json()) as Overview;
  expect(data.repos).toEqual([
    expect.objectContaining({ id: repoId, name: 'source', missing: false, workspaceCount: 1 }),
  ]);
  expect(data.profileCount).toBe(1);
  const [item] = data.workspaces;
  expect(item).toMatchObject({
    id: pulled.workspaceId,
    repoId,
    state: 'to-push',
    counts: { tracked: 2, modified: 1, added: 1, deleted: 0 },
    sourceMoved: false,
  });
  expect(item?.lastPullAt).toEqual(expect.any(String));
  expect(item?.lineage.repo.name).toBe('source');
  expect(item?.lineage.worktree).toMatchObject({ path: source, branch: 'main' });
  expect(item?.lineage.cloak.path).toBe(workspace);
  expect(data.launch).toMatchObject({ kind: 'repo', label: 'source', branch: 'main' });

  await rm(workspace, { recursive: true });
  const gone = (await (await get('/api/v2/overview')).json()) as Overview;
  expect(gone.workspaces[0]?.state).toBe('missing');
  expect(gone.launch).toEqual({ kind: 'none' });
});

it('never echoes an unregistered launch path', async () => {
  const { dashboard, get } = await fixture();
  const context = await dashboard.context();
  const query = new URLSearchParams({ repo: context.repoId as string, worktree: '/etc/secret' });
  const data = (await (await get(`/api/v2/overview?${query}`)).json()) as Overview;
  expect(JSON.stringify(data)).not.toContain('/etc/secret');
  const invalid = await get('/api/v2/overview?repo=../../etc');
  expect(invalid.status).toBe(400);
});

it('reports unknown operations through the shared operation routes', async () => {
  const { get, base } = await fixture();
  const status = await get('/api/v2/operations/missing');
  expect(status.status).toBe(404);
  expect(await status.json()).toMatchObject({ code: 'unknown' });
  const apply = await fetch(`${base}/api/v2/operations/missing/apply`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(apply.status).toBe(404);
});
