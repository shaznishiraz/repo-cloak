import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { runGit } from '../../src/adapters/git.js';
import { createStore } from '../../src/adapters/store.js';
import { createDashboard } from '../../src/commands/dashboard.js';
import { createDashboardServer } from '../../src/adapters/server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cloak dashboard '));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = createStore(join(root, 'store'));
  const dashboard = createDashboard(store, root);
  const server = createDashboardServer(dashboard, 'test-token', resolve('src/ui'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer test-token',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { store, dashboard, server, address, base, call };
}

it('requires a token on every API route and rejects foreign origins', async () => {
  const { base, call } = await fixture();
  for (const path of [
    '/api/repos',
    '/api/profiles',
    '/api/session',
    '/api/settings',
    '/api/folders',
    '/api/schema/profile',
    '/api/workspaces/a/b',
    '/api/repos/a/worktrees',
    '/api/repos/a/selection',
    '/api/repos/a/inventory',
    '/api/repos/a/selection-context',
    '/api/sync/preview',
    '/api/sync/example',
    '/api/sync/example/apply',
  ]) {
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    expect(
      (await fetch(`${base}${path}`, { headers: { Authorization: 'Bearer wrong-token' } })).status,
    ).toBe(401);
  }
  expect(
    (
      await fetch(`${base}/api/repos`, {
        headers: { Authorization: 'Bearer test-token', Origin: 'https://foreign.test' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${base}/api/repos`, {
        headers: { Authorization: 'Bearer test-token', Origin: base },
      })
    ).status,
  ).toBe(200);
  expect(await (await call('/api/repos')).json()).toEqual([]);
});

it('binds loopback only, blocks a foreign Host, and serves only known assets', async () => {
  const { address, base } = await fixture();
  expect(address.address).toBe('127.0.0.1');
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(
      `${base}/api/repos`,
      { headers: { Host: 'foreign.test', Authorization: 'Bearer test-token' } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
  expect(status).toBe(403);
  const page = await fetch(base);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect(page.headers.get('cache-control')).toBe('no-store');
  expect(await page.text()).toContain('Local dashboard');
  expect((await fetch(`${base}/key`)).status).toBe(404);
  expect((await fetch(`${base}/app.js`)).headers.get('content-type')).toContain('javascript');
});

it('uses CLI profile validation and supports save, edit, check and confirmed deletion', async () => {
  const { call, store } = await fixture();
  const profile = {
    kind: 'profile',
    schemaVersion: 1,
    name: 'client',
    rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    extensions: { custom: true },
  };
  const scope = { kind: 'global' };
  const invalid = await call('/api/profiles', 'POST', {
    scope,
    profile: { ...profile, rules: [{ id: 'broken', type: 'regex', match: '[', replace: 'x' }] },
  });
  expect(invalid.status).toBe(400);
  expect(JSON.stringify(await invalid.json())).toContain('broken');
  expect(await (await call('/api/profiles')).json()).toEqual([]);
  const saved = (await (await call('/api/profiles', 'POST', { scope, profile })).json()) as {
    id: string;
  };
  expect(saved.id).toMatch(/^pf_/);
  const disk = await readFile(join(store.root, 'profiles', `${saved.id}.json`), 'utf8');
  expect(disk).not.toContain('Acme');
  expect(
    (
      await call('/api/profiles', 'POST', {
        id: saved.id,
        scope,
        profile: { ...profile, description: 'edited' },
      })
    ).status,
  ).toBe(200);
  expect(
    await (await call('/api/profiles/check', 'POST', [{ scope, id: saved.id }])).json(),
  ).toEqual({ profiles: 1, rules: 1 });
  expect(
    (
      await call('/api/profiles/check', 'POST', [
        { scope, id: saved.id },
        { scope, id: saved.id },
      ])
    ).status,
  ).toBe(400);
  expect((await call('/api/profiles', 'DELETE', { scope, id: saved.id })).status).toBe(200);
  expect(await (await call('/api/profiles')).json()).toEqual([]);
});

it('rejects malformed and oversized requests', async () => {
  const { base } = await fixture();
  expect(
    (
      await fetch(`${base}/api/profiles`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(`${base}/api/profiles`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
        body: '{}',
      })
    ).status,
  ).toBe(415);
  expect(
    (
      await fetch(`${base}/api/profiles`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify('a'.repeat(1024 * 1024)),
      })
    ).status,
  ).toBe(413);
});

it('rejects unauthorized write requests before changing any saved profile', async () => {
  const { call, base, store } = await fixture();
  const scope = { kind: 'global' };
  const profile = { kind: 'profile', schemaVersion: 1, name: 'protected', rules: [] };
  const saved = (await (await call('/api/profiles', 'POST', { scope, profile })).json()) as {
    id: string;
  };
  const path = join(store.root, 'profiles', `${saved.id}.json`);
  const before = await readFile(path);
  const requests = [
    {
      path: '/api/profiles',
      method: 'POST',
      body: { id: saved.id, scope, profile: { ...profile, name: 'changed' } },
    },
    { path: '/api/profiles', method: 'DELETE', body: { id: saved.id, scope } },
    { path: '/api/profiles/check', method: 'POST', body: [{ id: saved.id, scope }] },
  ];
  for (const request of requests) {
    const options = { method: request.method, body: JSON.stringify(request.body) };
    expect(
      (
        await fetch(`${base}${request.path}`, {
          ...options,
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}${request.path}`, {
          ...options,
          headers: {
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
            Origin: 'https://foreign.test',
          },
        })
      ).status,
    ).toBe(403);
  }
  expect(await readFile(path)).toEqual(before);
  expect(await (await call('/api/profiles')).json()).toEqual([
    expect.objectContaining({ id: saved.id }),
  ]);
});

it('authenticates sync mutations and serves preview/apply/status with structured errors', async () => {
  const { store, dashboard, base, call } = await fixture();
  expect((await call('/api/folders?offset=-1')).status).toBe(400);
  const source = join(store.root, '..', 'source');
  const destination = join(store.root, '..', 'workspace');
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
  const input = {
    intent: 'create',
    repoId,
    worktree: source,
    destination,
    files: ['Acme.txt'],
    profiles: [{ id: saved.id, scope: saved.scope }],
  };
  for (const headers of [
    { 'Content-Type': 'application/json' },
    {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      Origin: 'https://foreign.test',
    },
  ]) {
    expect(
      (
        await fetch(`${base}/api/sync/preview`, {
          method: 'POST',
          headers,
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(headers.Origin ? 403 : 401);
  }
  const preview = (await (await call('/api/sync/preview', 'POST', input)).json()) as {
    operationId: string;
  };
  expect((await call(`/api/sync/${preview.operationId}`)).status).toBe(200);
  for (const path of [
    `/api/sync/${preview.operationId}/apply`,
    `/api/sync/${preview.operationId}`,
  ]) {
    for (const headers of [
      { 'Content-Type': 'application/json' },
      {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
        Origin: 'https://foreign.test',
      },
    ]) {
      expect(
        (
          await fetch(`${base}${path}`, {
            method: path.endsWith('apply') ? 'POST' : 'DELETE',
            headers,
            ...(path.endsWith('apply') ? { body: '{}' } : {}),
          })
        ).status,
      ).toBe(headers.Origin ? 403 : 401);
    }
  }
  expect((await call(`/api/sync/${preview.operationId}/apply`, 'POST', {})).status).toBe(200);
  await dashboard.sync.wait(preview.operationId);
  expect(await (await call(`/api/sync/${preview.operationId}`)).json()).toMatchObject({
    state: 'completed',
  });
  expect(await readFile(join(destination, 'Northwind.txt'), 'utf8')).toBe('Northwind');
  const invalid = await call('/api/sync/unknown');
  expect(invalid.status).toBe(404);
  expect(await invalid.json()).toMatchObject({ code: 'unknown' });
  const cancelled = (await (
    await call('/api/sync/preview', 'POST', {
      intent: 'refresh',
      repoId,
      workspaceId: (await dashboard.sync.wait(preview.operationId)).result?.workspaceId,
      worktree: source,
    })
  ).json()) as { operationId: string };
  expect((await call(`/api/sync/${cancelled.operationId}`, 'DELETE')).status).toBe(200);
  expect((await call(`/api/sync/${cancelled.operationId}/apply`, 'POST', {})).status).toBe(410);
  const finished = await dashboard.sync.wait(preview.operationId);
  const workspaceUrl = `/api/workspaces/${repoId}/${finished.result?.workspaceId}`;
  const deletion = { path: finished.result?.workspace, confirm: true };
  expect(
    (
      await fetch(base + workspaceUrl, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deletion),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(base + workspaceUrl, {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer test-token',
          Origin: 'https://foreign.test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(deletion),
      })
    ).status,
  ).toBe(403);
  expect((await call(workspaceUrl, 'DELETE', { path: destination })).status).toBe(400);
  expect(await readFile(join(destination, 'Northwind.txt'), 'utf8')).toBe('Northwind');
  const removed = await call(workspaceUrl, 'DELETE', deletion);
  expect(removed.status, await removed.text()).toBe(200);
  expect((await call(workspaceUrl)).status).toBe(400);
});

it('searches nested paths across the repository while keeping directory browsing scoped', async () => {
  const { store, call } = await fixture();
  const source = join(store.root, '..', 'search-source');
  await mkdir(join(source, 'src'), { recursive: true });
  await runGit(source, ['init', '-b', 'main']);
  await writeFile(join(source, 'src', 'Example.ts'), 'example');
  const { repoId } = await createDashboard(store, source).context();
  const query = new URLSearchParams({ worktree: source, query: 'EXAMPLE' });
  expect(await (await call(`/api/repos/${repoId}/selection?${query}`)).json()).toMatchObject({
    files: ['src/Example.ts'],
    working: ['src/Example.ts'],
    workingCount: 1,
  });
  query.set('directory', '');
  expect(await (await call(`/api/repos/${repoId}/selection?${query}`)).json()).toMatchObject({
    files: [],
    directories: ['src'],
  });
});

it('validates inventory ignore preferences and serves only fresh path metadata', async () => {
  const { store, call } = await fixture();
  const source = join(store.root, '..', 'inventory-source');
  await mkdir(source);
  await runGit(source, ['init', '-b', 'main']);
  await writeFile(join(source, '.gitignore'), '.env\n');
  await writeFile(join(source, '.env'), 'synthetic private content');
  const { repoId } = await createDashboard(store, source).context();
  const query = new URLSearchParams({ worktree: source });
  const url = `/api/repos/${repoId}/inventory?${query}`;
  expect(await (await call(url)).json()).toEqual({ files: ['.gitignore'] });
  const shown = await (await call(url + '&respectGitIgnore=false')).json();
  expect(shown).toEqual({ files: ['.env', '.gitignore'] });
  expect(JSON.stringify(shown)).not.toContain('synthetic private content');
  expect((await call(url + '&respectGitIgnore=invalid')).status).toBe(400);
  await writeFile(join(source, 'fresh.ts'), 'fresh');
  expect(await (await call(url)).json()).toEqual({ files: ['.gitignore', 'fresh.ts'] });
  expect((await call(`/api/repos/${repoId}/selection-context?${query}`)).status).toBe(200);
});
