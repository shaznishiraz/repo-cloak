// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { createClient, ApiError } from '../../src/web/api/client.js';
import { createIdleLock } from '../../src/web/screens/settings/auto-lock.js';
import { endSession, shareActivity, startLockChannel } from '../../src/web/shell/lock.js';
import { Shell } from '../../src/web/shell/shell.js';
import { locked } from '../../src/web/shell/state.js';

afterEach(() => {
  vi.useRealTimers();
  locked.value = false;
});
const memory = () => {
  const items = new Map([
    ['cloak-token', 'secret'],
    ['cloak-launch', '{}'],
  ]);
  return { items, removeItem: (key: string) => void items.delete(key) };
};

it('locks and forgets the token before the revoke answers, then reloads', async () => {
  const storage = memory();
  const reload = vi.fn();
  let answer = () => {};
  const done = endSession(
    () => new Promise<void>((resolve) => (answer = resolve)),
    storage,
    reload,
  );
  expect(locked.value).toBe(true);
  expect(storage.items.size).toBe(0);
  expect(reload).not.toHaveBeenCalled();
  answer();
  await done;
  expect(reload).toHaveBeenCalledOnce();
});

it('still locks when the revoke fails', async () => {
  const reload = vi.fn();
  await endSession(() => Promise.reject(new Error('offline')), memory(), reload);
  expect(locked.value).toBe(true);
  expect(reload).toHaveBeenCalledOnce();
});

it('still locks when the revoke never answers', async () => {
  vi.useFakeTimers();
  const reload = vi.fn();
  const done = endSession(() => new Promise(() => {}), memory(), reload);
  await vi.advanceTimersByTimeAsync(2_000);
  await done;
  expect(reload).toHaveBeenCalledOnce();
});

it('locks once, however many causes arrive', async () => {
  const reload = vi.fn();
  const revoke = vi.fn(() => Promise.resolve());
  await Promise.all([endSession(revoke, memory(), reload), endSession(revoke, memory(), reload)]);
  expect(revoke).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
});

it('calls back on 401 only, and still throws the error', async () => {
  const onUnauthorized = vi.fn();
  const statuses = [500, 403, 404, 401];
  const client = createClient(
    't',
    (async () =>
      new Response(JSON.stringify({ error: 'no' }), { status: statuses.shift() ?? 200 })) as never,
    onUnauthorized,
  );
  for (let call = 0; call < 3; call++)
    await expect(client.call('GET /api/v2/session')).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).not.toHaveBeenCalled();
  await expect(client.call('GET /api/v2/session')).rejects.toMatchObject({ status: 401 });
  expect(onUnauthorized).toHaveBeenCalledOnce();
});

it('shows only the lock screen, with how to unlock and no token', () => {
  const root = document.createElement('div');
  document.body.append(root);
  locked.value = true;
  act(() => render(<Shell />, root));
  expect(root.querySelector('main')?.getAttribute('aria-label')).toBe('Locked');
  expect(root.textContent).toContain('Dashboard locked');
  expect(root.textContent).toContain('repo-cloak');
  expect(root.querySelector('nav')).toBeNull();
  expect(root.querySelector('input, a, button')).toBeNull();
  act(() => render(null, root));
  root.remove();
});

it('another tab can lock this one, and activity reaches the idle timer', async () => {
  const onActivity = vi.fn();
  const location = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  const stop = startLockChannel(onActivity);
  const other = new BroadcastChannel('cloak-session');
  try {
    other.postMessage('activity');
    await vi.waitFor(() => expect(onActivity).toHaveBeenCalledOnce());
    expect(locked.value).toBe(false);
    other.postMessage('unknown');
    other.postMessage('lock');
    await vi.waitFor(() => expect(locked.value).toBe(true));
  } finally {
    other.close();
    stop();
    location.mockRestore();
  }
});

it('sends activity and lock to other tabs, without the token', async () => {
  const seen: unknown[] = [];
  const stop = startLockChannel(() => {});
  const other = new BroadcastChannel('cloak-session');
  other.onmessage = ({ data }: MessageEvent) => void seen.push(data);
  try {
    shareActivity();
    await endSession(
      () => Promise.resolve(),
      memory(),
      () => {},
    );
    await vi.waitFor(() => expect(seen).toEqual(['activity', 'lock']));
  } finally {
    other.close();
    stop();
  }
});

it('keeps working without BroadcastChannel', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  try {
    const stop = startLockChannel(() => {});
    shareActivity();
    stop();
    const reload = vi.fn();
    await endSession(() => Promise.resolve(), memory(), reload);
    expect(reload).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

function idle() {
  const clock = { now: 0 };
  const lock = vi.fn();
  const notify = vi.fn();
  const timer = createIdleLock(lock, () => clock.now, notify);
  return { clock, lock, notify, timer };
}

it('notifies the server of input at once, then at most once an interval', () => {
  vi.useFakeTimers();
  const { clock, notify, timer } = idle();
  timer.set(5);
  timer.activity();
  expect(notify).toHaveBeenCalledOnce();
  clock.now += 5_000;
  timer.activity();
  timer.activity();
  expect(notify).toHaveBeenCalledOnce();
  clock.now += 10_000;
  timer.check();
  expect(notify).toHaveBeenCalledTimes(2);
  clock.now += 15_000;
  timer.check();
  expect(notify).toHaveBeenCalledTimes(2);
  timer.set(null);
});

it('sends nothing without input, so checks alone cannot keep the server session alive', () => {
  vi.useFakeTimers();
  const { clock, notify, timer } = idle();
  timer.set(5);
  for (let tick = 0; tick < 10; tick++) {
    clock.now += 15_000;
    timer.check();
  }
  expect(notify).not.toHaveBeenCalled();
  timer.set(null);
});

it('sends nothing when no limit is set', () => {
  const { notify, timer } = idle();
  timer.activity();
  expect(notify).not.toHaveBeenCalled();
});

it('input past the limit locks instead of notifying', () => {
  vi.useFakeTimers();
  const { clock, lock, notify, timer } = idle();
  timer.set(5);
  clock.now += 5 * 60_000;
  timer.activity();
  expect(lock).toHaveBeenCalledOnce();
  expect(notify).not.toHaveBeenCalled();
});

it('input in another tab keeps this one from locking every tab', () => {
  vi.useFakeTimers();
  const { clock, lock, notify, timer } = idle();
  timer.set(5);
  clock.now += 4 * 60_000;
  timer.touch();
  clock.now += 4 * 60_000;
  timer.check();
  expect(lock).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  clock.now += 60_000;
  timer.check();
  expect(lock).toHaveBeenCalledOnce();
});
