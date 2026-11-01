import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDashboard } from '../../src/application/dashboard.js';
import { runUi } from '../../src/adapters/launcher.js';
import { startUiSession } from '../../src/adapters/ui-session.js';

// A store outside the home folder: this must reach neither the real store nor the keychain.
const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../src/adapters/store.js', async (original) => {
  const actual = await original<typeof import('../../src/adapters/store.js')>();
  return {
    ...actual,
    createStore: (root?: string) => actual.createStore(root ?? paths.root),
  };
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function running() {
  const { createStore } = await import('../../src/adapters/store.js');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'cloak launcher ')));
  cleanups.push(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  paths.root = join(home, 'store');
  const store = createStore(paths.root);
  const session = await startUiSession(
    store.root,
    createDashboard(store, home),
    0,
    resolve('src/web'),
  );
  cleanups.push(() => session.close());
  const status = (token: string) =>
    fetch(`http://127.0.0.1:${session.port}/api/v2/session`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.status);
  const relaunch = async () => {
    const output: string[] = [];
    await runUi((text) => output.push(text), { open: false, cwd: home });
    const printed = output.join('');
    const url = new URL(/http:\S+/.exec(printed)?.[0] ?? '');
    return { printed, url, token: new URLSearchParams(url.hash.slice(1)).get('token') ?? '' };
  };
  return { session, status, relaunch };
}

it('running repo-cloak again prints a fresh token in the fragment only', async () => {
  const { session, status, relaunch } = await running();
  const next = await relaunch();
  expect(next.printed).toContain('Using the running dashboard');
  expect(next.url.port).toBe(String(session.port));
  expect(next.url.pathname).toBe('/');
  expect(next.url.search).toBe('');
  expect(next.token).toMatch(/^[a-f0-9]{64}$/);
  expect(next.token).not.toBe(session.token);
  expect(await status(next.token)).toBe(200);
  expect(await status(session.token)).toBe(200);
});

it('running repo-cloak after a lock opens the same server with a new working token', async () => {
  const { session, status, relaunch } = await running();
  await fetch(`http://127.0.0.1:${session.port}/api/v2/session/lock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
  });
  expect(await status(session.token)).toBe(401);
  const next = await relaunch();
  expect(next.url.port).toBe(String(session.port));
  expect(await status(next.token)).toBe(200);
  expect(await status(session.token)).toBe(401);
});
