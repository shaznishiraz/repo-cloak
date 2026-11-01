import { clearSession } from '../api/session.js';
import { locked } from './state.js';

const revokeWaitMs = 2_000;
let channel: BroadcastChannel | undefined;

/**
 * Locks this tab: the lock screen and forgetting the token come first, so a slow or dead server
 * cannot hold them up. The reload clears what is in memory. `revoke` runs only when this tab is
 * the one ending the session; a tab told by a 401 or another tab has nothing left to revoke.
 */
export async function endSession(
  revoke: () => Promise<unknown> = () => Promise.resolve(),
  storage: Pick<Storage, 'removeItem'> = sessionStorage,
  reload: () => void = () => location.reload(),
) {
  if (locked.value) return;
  locked.value = true;
  clearSession(storage);
  await Promise.race([
    revoke().catch(() => undefined),
    new Promise((done) => setTimeout(done, revokeWaitMs)),
  ]);
  channel?.postMessage('lock');
  reload();
}

/** Tells other tabs this user is here. Carries no token. */
export function shareActivity() {
  channel?.postMessage('activity');
}

/** Hidden tabs do not poll, so other tabs of this dashboard hear about a lock here. */
export function startLockChannel(onActivity: () => void) {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const opened = new BroadcastChannel('cloak-session');
  channel = opened;
  opened.onmessage = ({ data }: MessageEvent) => {
    if (data === 'lock') void endSession();
    else if (data === 'activity') onActivity();
  };
  return () => {
    opened.close();
    channel = undefined;
  };
}
