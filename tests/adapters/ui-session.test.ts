import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { createDashboard } from '../../src/commands/dashboard.js';
import { startUiSession } from '../../src/adapters/ui-session.js';

it('reuses one server for concurrent launches and removes session files on shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak ui session '));
  const store = createStore(root);
  const dashboard = createDashboard(store, root);
  const first = await startUiSession(root, dashboard, 0, resolve('src/ui'));
  try {
    const second = await startUiSession(root, dashboard, 0, resolve('src/ui'));
    expect(second.reused).toBe(true);
    expect(second.port).toBe(first.port);
    expect(second.token).toBe(first.token);
    await second.close();
    expect((await fetch(`http://127.0.0.1:${first.port}/`)).status).toBe(200);
    const record = JSON.parse(await readFile(join(root, 'ui.lock'), 'utf8')) as { token: string };
    expect(record.token).toBe(first.token);
    if (process.platform !== 'win32')
      expect((await stat(join(root, 'ui.lock'))).mode & 0o777).toBe(0o600);
  } finally {
    await first.close();
  }
  expect(await readdir(root)).toEqual([]);
  await rm(root, { recursive: true, force: true });
});

it('ships less than 50 KB of browser assets', async () => {
  const sizes = await Promise.all(
    ['index.html', 'app.js', 'app.css'].map(
      async (name) => (await stat(join('src/ui', name))).size,
    ),
  );
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThan(50_000);
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
    resolve('src/ui'),
  );
  try {
    expect(session.reused).toBe(false);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
