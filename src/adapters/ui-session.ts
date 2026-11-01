import { randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { lock } from 'proper-lockfile';
import { z } from 'zod';
import { errorCode, writeAtomic } from './atomic.js';
import { createDashboardServer } from './server.js';
import type { Dashboard } from '../application/dashboard.js';

const sessionSchema = z.object({
  port: z.number().int().min(1).max(65535),
  launcherKey: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive(),
});
const launchSchema = z.object({
  app: z.literal('repo-cloak'),
  protocol: z.literal(2),
  pid: z.number().int().positive(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
export type UiSession = { port: number; token: string; reused: boolean; close(): Promise<void> };

export async function startUiSession(
  root: string,
  dashboard: Dashboard,
  port = 0,
  assetRoot?: string,
): Promise<UiSession> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = join(root, 'ui.lock');
  let release: (() => Promise<void>) | undefined;
  // A short guard covers startup, shutdown and stale-process recovery.
  for (let attempt = 0; attempt < 65; attempt++) {
    try {
      release = await lock(root, {
        lockfilePath: join(root, 'ui.guard'),
        stale: 5000,
        update: 1000,
        retries: 0,
      });
      break;
    } catch (error) {
      if (errorCode(error) !== 'ELOCKED') throw error;
      try {
        const session = sessionSchema.parse(JSON.parse(await readFile(metadata, 'utf8')));
        // Every launch gets its own token, so this works after a lock as well.
        const response = await fetch(`http://127.0.0.1:${session.port}/launcher/v1/session`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.launcherKey}` },
          signal: AbortSignal.timeout(300),
          redirect: 'error',
        });
        const info = launchSchema.parse(await response.json());
        if (response.ok && info.pid === session.pid)
          return { port: session.port, token: info.token, reused: true, close: async () => {} };
      } catch {
        /* The owner may still be starting, or its guard may be stale. */
      }
      await setTimeout(100);
    }
  }
  if (!release) throw new Error('The dashboard is starting or shutting down; try again shortly');
  const token = randomBytes(32).toString('hex');
  const launcherKey = randomBytes(32).toString('hex');
  const server = createDashboardServer(dashboard, token, assetRoot, { launcherKey });
  const unlock = release;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        await unlink(metadata).catch((error) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        });
      } finally {
        await unlock();
      }
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not bind dashboard port');
    await writeAtomic(
      metadata,
      `${JSON.stringify({ port: address.port, launcherKey, pid: process.pid })}\n`,
    );
    return { port: address.port, token, reused: false, close };
  } catch (error) {
    if (server.listening) await close();
    else await unlock();
    throw error;
  }
}
