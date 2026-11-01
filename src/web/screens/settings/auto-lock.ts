import { effect } from '@preact/signals';
import { api, lockTab } from '../../shell/load.js';
import { shareActivity, startLockChannel } from '../../shell/lock.js';
import { sessionInfo } from '../../shell/state.js';

const checkEveryMs = 15_000;
const notifyEveryMs = 15_000;

/**
 * The tab's half of auto-lock. The server keeps its own idle clock, which this feeds with real
 * input only, and this still locks the tab if the server has gone away. Sends at most one notice
 * per interval; input inside an interval is sent by the next check.
 */
export function createIdleLock(
  lock: () => void,
  now: () => number = Date.now,
  notify: () => void = () => {},
) {
  let minutes: number | null = null;
  let last = now();
  let sent = -Infinity;
  let unsent = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  function flush() {
    if (!unsent || now() - sent < notifyEveryMs) return;
    unsent = false;
    sent = now();
    notify();
  }
  function check() {
    if (minutes !== null && now() - last >= minutes * 60_000) {
      clearInterval(timer);
      timer = undefined;
      minutes = null;
      lock();
      return;
    }
    flush();
  }
  return {
    check,
    activity() {
      // A tab left open past its limit locks on return; touching it must not rescue it.
      check();
      last = now();
      if (minutes === null) return;
      unsent = true;
      flush();
    },
    /** Input in another tab. Firing revokes every tab, so it must not fire over one in use. */
    touch() {
      last = now();
    },
    set(value: number | null) {
      minutes = value;
      if (value === null) {
        clearInterval(timer);
        timer = undefined;
      } else timer ??= setInterval(check, checkEveryMs);
    },
  };
}

export const idleLock = createIdleLock(
  () => void lockTab(),
  Date.now,
  () => {
    shareActivity();
    api()
      .call('POST /api/v2/session/activity')
      .catch(() => {
        // A 401 has already locked the tab; anything else leaves the check to the next input.
      });
  },
);

/** Runs on every screen. Rereads the limit on each session refresh, so policy changes apply. */
export function startAutoLock() {
  const onActivity = () => idleLock.activity();
  const onVisible = () => idleLock.check();
  document.addEventListener('pointerdown', onActivity, { passive: true });
  document.addEventListener('keydown', onActivity);
  document.addEventListener('visibilitychange', onVisible);
  const stopChannel = startLockChannel(() => idleLock.touch());
  // A new tab's session must not be revoked by another tab that has been idle until now.
  shareActivity();
  const stop = effect(() => {
    if (!sessionInfo.value) return;
    void (async () => {
      try {
        const settings = await api().call('GET /api/v2/settings');
        idleLock.set(settings.security.autoLockMinutes);
      } catch {
        // Keep the limit already in force until the next refresh.
      }
    })();
  });
  return () => {
    stop();
    stopChannel();
    idleLock.set(null);
    document.removeEventListener('pointerdown', onActivity);
    document.removeEventListener('keydown', onActivity);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
