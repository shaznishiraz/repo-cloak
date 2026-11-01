import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();
/** Checks every entry without stopping early, so timing shows neither position nor length. */
function includes(digests: readonly Buffer[], header: string | undefined) {
  const supplied = digest(header ?? '');
  let found = false;
  for (const entry of digests) found = timingSafeEqual(entry, supplied) || found;
  return typeof header === 'string' && found;
}

/**
 * Decides which browser sessions are live. Tokens exist only in memory, as digests, and are
 * added once from fresh random bytes, so a revoked token can never become valid again.
 */
export function createSessionGate({
  token,
  launcherKey,
  idleLimit,
  now = Date.now,
}: {
  token: string;
  /** Proves a later launch is by this account. Without one, no launch can get a token. */
  launcherKey?: string | undefined;
  /** Minutes without user input before every token expires; null means never. */
  idleLimit: () => Promise<number | null>;
  now?: () => number;
}) {
  const tokens = [digest(`Bearer ${token}`)];
  const launcher = launcherKey ? [digest(`Bearer ${launcherKey}`)] : [];
  let last = now();
  let limit: number | null = null;

  async function sweep() {
    try {
      limit = await idleLimit();
    } catch {
      // Keep the limit already in force: an unreadable file must not loosen or lock anything.
    }
    const time = now();
    if (limit === null) last = time;
    else if (time - last >= limit * 60_000) tokens.length = 0;
  }
  return {
    async authorize(header: string | undefined) {
      if (!includes(tokens, header)) return false;
      await sweep();
      // Checked again: the read above can span a lock or an expiry.
      return includes(tokens, header);
    },
    /** A fresh token for a launcher that proved itself. Old tokens are swept first, never saved. */
    async launch(header: string | undefined) {
      if (!includes(launcher, header)) return null;
      await sweep();
      const fresh = randomBytes(32).toString('hex');
      tokens.push(digest(`Bearer ${fresh}`));
      last = now();
      return fresh;
    },
    /** User input in a tab. Polling and other API calls must not reach this. */
    activity() {
      last = now();
    },
    revoke() {
      tokens.length = 0;
    },
  };
}
export type SessionGate = ReturnType<typeof createSessionGate>;
