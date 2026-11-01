import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { runGit } from '../../src/adapters/git.js';
import { createStore } from '../../src/adapters/store.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { createDashboardServer } from '../../src/adapters/server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cloak dashboard '));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const assets = join(root, 'assets');
  await mkdir(assets);
  await Promise.all(
    ['index.html', 'app.js', 'app.css', 'favicon.svg', 'favicon.ico', 'supply-chain.json'].map(
      (name) => writeFile(join(assets, name), `asset ${name}`),
    ),
  );
  await writeFile(join(assets, 'key'), 'must never be served');
  const store = createStore(join(root, 'store'));
  const dashboard = createDashboard(store, root);
  const server = createDashboardServer(dashboard, 'test-token', assets);
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
  return { root, store, dashboard, address, base: `http://127.0.0.1:${address.port}` };
}
const auth = { Authorization: 'Bearer test-token' };
const json = { 'Content-Type': 'application/json' };
const foreign = { Origin: 'https://foreign.test' };

it('requires the token and a local origin on every API path', async () => {
  const { base } = await fixture();
  for (const path of ['/api/v2/session', '/api/v2/overview', '/api/anything']) {
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    expect(
      (await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer wrong-token' } })).status,
    ).toBe(401);
    expect((await fetch(`${base}${path}`, { headers: { ...auth, ...foreign } })).status).toBe(403);
  }
  const local = await fetch(`${base}/api/v2/session`, { headers: { ...auth, Origin: base } });
  expect(local.status).toBe(200);
});

it('no longer serves the removed dashboard routes', async () => {
  const { base } = await fixture();
  for (const path of ['/api/session', '/api/repos', '/api/profiles', '/api/settings', '/api/groups', '/api/sync/x'])
    expect((await fetch(`${base}${path}`, { headers: auth })).status).toBe(404);
});

it('binds loopback only, blocks a foreign Host, and serves only known assets', async () => {
  const { address, base } = await fixture();
  expect(address.address).toBe('127.0.0.1');
  const status = await new Promise<number | undefined>((done, fail) => {
    const outgoing = request(
      `${base}/api/v2/session`,
      { headers: { ...auth, Host: 'foreign.test' } },
      (response) => {
        response.resume();
        done(response.statusCode);
      },
    );
    outgoing.on('error', fail);
    outgoing.end();
  });
  expect(status).toBe(403);
  const page = await fetch(base);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(await page.text()).toBe('asset index.html');
  expect((await fetch(`${base}/key`)).status).toBe(404);
  expect((await fetch(`${base}/../key`)).status).toBe(404);
  expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('javascript');
  expect((await fetch(`${base}/favicon.svg`)).headers.get('content-type')).toBe('image/svg+xml');
  for (const path of ['/favicon.ico', '/favicon.ico?v=2'])
    expect((await fetch(`${base}${path}`)).headers.get('content-type')).toBe('image/x-icon');
  expect((await fetch(`${base}/app.js`, { method: 'POST' })).status).toBe(404);
});

it('rejects malformed and oversized requests', async () => {
  const { base } = await fixture();
  const url = `${base}/api/v2/operations/missing/apply`;
  const post = (headers: Record<string, string>, body: string) =>
    fetch(url, { method: 'POST', headers: { ...auth, ...headers }, body });
  expect((await post(json, '{')).status).toBe(400);
  expect((await post({}, '{}')).status).toBe(415);
  expect((await post(json, JSON.stringify('a'.repeat(1024 * 1024)))).status).toBe(413);
});

it('rejects unauthenticated and foreign mutations before they change an operation', async () => {
  const { root, store, dashboard, base } = await fixture();
  const source = join(root, 'source');
  await mkdir(source);
  await runGit(source, ['init', '-b', 'main']);
  await writeFile(join(source, 'Acme.txt'), 'Acme');
  const { repoId } = await createDashboard(store, source).context();
  const saved = await dashboard.saveProfile({
    scope: { kind: 'global' },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'company',
      rules: [{ id: 'name', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    },
  });
  const destination = join(root, 'workspace');
  const preview = await dashboard.sync.preview({
    intent: 'create',
    repoId,
    worktree: source,
    destination,
    files: ['Acme.txt'],
    profiles: [{ id: saved.id, scope: saved.scope }],
  });
  const operation = `${base}/api/v2/operations/${preview.operationId}`;
  for (const [headers, status] of [
    [json, 401],
    [{ ...auth, ...json, ...foreign }, 403],
  ] as const) {
    expect(
      (await fetch(`${operation}/apply`, { method: 'POST', headers, body: '{}' })).status,
    ).toBe(status);
    expect((await fetch(operation, { method: 'DELETE', headers })).status).toBe(status);
  }
  expect(await (await fetch(operation, { headers: auth })).json()).toMatchObject({
    state: 'pending',
  });
  const applied = await fetch(`${operation}/apply`, {
    method: 'POST',
    headers: { ...auth, ...json },
    body: '{}',
  });
  expect(applied.status).toBe(200);
  await dashboard.sync.wait(preview.operationId);
  expect(await readFile(join(destination, 'Northwind.txt'), 'utf8')).toBe('Northwind');
  const unknown = await fetch(`${base}/api/v2/operations/unknown`, { headers: auth });
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toMatchObject({ code: 'unknown' });
});

it('keeps agent routes direct-only and behind a scoped credential', async () => {
  const { base } = await fixture();
  const url = `${base}/agent/v1/info`;
  expect((await fetch(url, { headers: foreign })).status).toBe(403);
  expect((await fetch(url)).status).toBe(401);
  // The dashboard session token is not an agent credential.
  expect((await fetch(url, { headers: auth })).status).toBe(401);
});
