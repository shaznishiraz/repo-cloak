import { effect } from '@preact/signals';
import { clearSession } from '../../api/session.js';
import { api } from '../../shell/load.js';
import { sessionInfo } from '../../shell/state.js';

type SessionStore = Pick<Storage, 'removeItem'>;
const checkEveryMs = 15_000;

/**
 * Locks this tab, not the sealed store: the session token goes, so nothing real shows until
 * someone at this account runs repo-cloak for a new link. The reload clears what is in memory.
 */
export function lockTab(
  storage: SessionStore = sessionStorage,
  reload: () => void = () => location.reload(),
) {
  clearSession(storage);
  reload();
}

export function createIdleLock(lock: () => void, now: () => number = Date.now) {
  let minutes: number | null = null;
  let last = now();
  let timer: ReturnType<typeof setInterval> | undefined;
  function check() {
    if (minutes !== null && now() - last >= minutes * 60_000) {
      clearInterval(timer);
      timer = undefined;
      minutes = null;
      lock();
    }
  }
  return {
    check,
    activity() {
      // A tab left open past its limit locks on return; touching it must not rescue it.
      check();
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

export const idleLock = createIdleLock(() => lockTab());

/** Runs on every screen. Rereads the limit on each session refresh, so policy changes apply. */
export function startAutoLock() {
  const onActivity = () => idleLock.activity();
  const onVisible = () => idleLock.check();
  document.addEventListener('pointerdown', onActivity, { passive: true });
  document.addEventListener('keydown', onActivity);
  document.addEventListener('visibilitychange', onVisible);
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
    idleLock.set(null);
    document.removeEventListener('pointerdown', onActivity);
    document.removeEventListener('keydown', onActivity);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
