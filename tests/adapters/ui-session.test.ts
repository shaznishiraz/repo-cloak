import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildWeb } from '../../scripts/build-ui.js';
import { expect, it } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { startUiSession } from '../../src/adapters/ui-session.js';

it('reuses one server for concurrent launches and removes session files on shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak ui session '));
  const store = createStore(root);
  const dashboard = createDashboard(store, root);
  const sessions = await Promise.all([
    startUiSession(root, dashboard, 0, resolve('src/web')),
    startUiSession(root, dashboard, 0, resolve('src/web')),
  ]);
  const first = sessions.find((session) => !session.reused);
  const second = sessions.find((session) => session.reused);
  if (!first || !second) {
    await Promise.all(sessions.map((session) => session.close()));
    throw new Error('Expected one owner and one reused session');
  }
  try {
    expect(second.reused).toBe(true);
    expect(second.port).toBe(first.port);
    expect(second.token).not.toBe(first.token);
    await second.close();
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
    // Browser tokens never reach the disk, so reading the file cannot resume a locked session.
    const record = await readFile(join(root, 'ui.lock'), 'utf8');
    expect(record).not.toContain(first.token);
    expect(record).not.toContain(second.token);
    expect(Object.keys(JSON.parse(record) as object).sort()).toEqual([
      'launcherKey',
      'pid',
      'port',
    ]);
    if (process.platform !== 'win32')
      expect((await stat(join(root, 'ui.lock'))).mode & 0o777).toBe(0o600);
  } finally {
    await first.close();
  }
  expect(await readdir(root)).toEqual([]);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('recovers a stale guard left by an exited process', async () => {
  const { mkdir, writeFile, utimes } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'cloak stale ui '));
  await mkdir(join(root, 'ui.guard'));
  const old = new Date(Date.now() - 20_000);
  await utimes(join(root, 'ui.guard'), old, old);
  await writeFile(join(root, 'ui.lock'), '{"stale":true}');
  const session = await startUiSession(
    root,
    createDashboard(createStore(root), root),
    0,
    resolve('src/web'),
  );
  try {
    expect(session.reused).toBe(false);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('releases its guard after a busy-port error so the next launch succeeds', async () => {
  const { createServer } = await import('node:http');
  const root = await mkdtemp(join(tmpdir(), 'cloak busy ui '));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  try {
    const dashboard = createDashboard(createStore(root), root);
    await expect(
      startUiSession(root, dashboard, address.port, resolve('src/web')),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(await readdir(root)).toEqual([]);
    const session = await startUiSession(root, dashboard, 0, resolve('src/web'));
    await session.close();
    await session.close();
    expect(await readdir(root)).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('serves the built dashboard with the security headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak ui web '));
  const out = join(root, 'assets');
  await buildWeb(out);
  const store = createStore(join(root, 'store'));
  const dashboard = createDashboard(store, root);
  const session = await startUiSession(store.root, dashboard, 0, out);
  try {
    const page = await fetch(`http://127.0.0.1:${session.port}/`);
    expect(await page.text()).toContain('id="app"');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await startUiSession(store.root, dashboard, 0, out)).reused).toBe(true);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

const sessionStatus = (port: number, token: string) =>
  fetch(`http://127.0.0.1:${port}/api/v2/session`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((response) => response.status);

it('a relaunch after a lock gets a fresh working token; the old ones stay dead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak relaunch '));
  const dashboard = createDashboard(createStore(root), root);
  const first = await startUiSession(root, dashboard, 0, resolve('src/web'));
  try {
    const other = await startUiSession(root, dashboard, 0, resolve('src/web'));
    expect(await sessionStatus(first.port, first.token)).toBe(200);
    expect(await sessionStatus(first.port, other.token)).toBe(200);
    const locked = await fetch(`http://127.0.0.1:${first.port}/api/v2/session/lock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${first.token}` },
    });
    expect(locked.status).toBe(200);
    expect(await sessionStatus(first.port, first.token)).toBe(401);
    expect(await sessionStatus(first.port, other.token)).toBe(401);
    const next = await startUiSession(root, dashboard, 0, resolve('src/web'));
    expect(next).toMatchObject({ reused: true, port: first.port });
    expect(next.token).not.toBe(first.token);
    expect(next.token).not.toBe(other.token);
    expect(await sessionStatus(first.port, next.token)).toBe(200);
    expect(await sessionStatus(first.port, first.token)).toBe(401);
    expect(await sessionStatus(first.port, other.token)).toBe(401);
  } finally {
    await first.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('does not reuse a server that answers with another pid', async () => {
  const { createServer } = await import('node:http');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'cloak impostor '));
  const impostor = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({ app: 'repo-cloak', protocol: 2, pid: 999_999, token: 'a'.repeat(64) }),
    );
  });
  await new Promise<void>((done) => impostor.listen(0, '127.0.0.1', done));
  const address = impostor.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await mkdir(join(root, 'ui.guard'));
  await writeFile(
    join(root, 'ui.lock'),
    JSON.stringify({ port: address.port, launcherKey: 'b'.repeat(64), pid: process.pid }),
  );
  const session = await startUiSession(
    root,
    createDashboard(createStore(root), root),
    0,
    resolve('src/web'),
  );
  try {
    // The guard goes stale and this launch takes over, rather than trusting that answer.
    expect(session.reused).toBe(false);
    expect(session.token).not.toBe('a'.repeat(64));
  } finally {
    await session.close();
    await new Promise<void>((done) => {
      impostor.close(() => done());
      impostor.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
