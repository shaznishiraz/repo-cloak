import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { createStore } from './store.js';
import { exists, checkDestinationPath } from './files.js';
import { writeAtomic } from './atomic.js';
import { agentId } from '../core/agent-requests.js';
import type { AgentDocument } from '../core/agent-requests.js';
import { hashBytes } from '../core/hash.js';

export function createAgentStore(store = createStore()) {
  const file = (id: string) => `agents/${agentId.parse(id)}.json`;
  async function read(id: string) {
    if (!(await exists(join(store.root, file(id))))) return undefined;
    const doc = await store.readSealed(file(id), 'agent');
    if (doc.workspaceId !== id) throw new Error('Agent workspace identity mismatch');
    return doc;
  }
  async function write(doc: AgentDocument) {
    await store.writeSealed(file(doc.workspaceId), doc.workspaceId, 'agent', doc);
  }
  async function locked<T>(id: string, action: () => Promise<T>) {
    const directory = join(store.root, 'agents');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lock(directory, {
      lockfilePath: join(directory, `${agentId.parse(id)}.lock`),
      retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }
  async function descriptor(doc: AgentDocument) {
    if (!(await exists(doc.path))) return;
    let baseUrl: string | null = null;
    try {
      const session = JSON.parse(await readFile(join(store.root, 'ui.lock'), 'utf8')) as {
        port: number;
      };
      if (Number.isInteger(session.port) && session.port > 0 && session.port < 65536)
        baseUrl = `http://127.0.0.1:${session.port}`;
    } catch {
      /* Offline descriptors are refreshed at dashboard startup. */
    }
    await checkDestinationPath(doc.path, '.repo-cloak/agent/connection.json');
    await writeAtomic(
      join(doc.path, '.repo-cloak/agent/connection.json'),
      JSON.stringify(
        {
          protocol: 1,
          workspaceId: doc.workspaceId,
          baseUrl,
          tokenFile: '.repo-cloak/agent/token',
        },
        null,
        2,
      ) + '\n',
    );
  }
  return {
    read,
    write,
    locked,
    async relocate(workspaceId: string, from: string, to: string) {
      return locked(workspaceId, async () => {
        const doc = await read(workspaceId);
        if (!doc) return false;
        if (doc.path !== from) throw new Error('Agent connection changed while moving');
        await write({ ...doc, path: to });
        return true;
      });
    },
    async ensure(
      input: { workspaceId: string; repoId: string; path: string; worktree: string },
      rotate = false,
    ) {
      return locked(input.workspaceId, async () => {
        let doc = await read(input.workspaceId);
        if (!doc || rotate) {
          const secret = randomBytes(32).toString('hex');
          doc = {
            ...input,
            kind: 'agent',
            schemaVersion: 1,
            enabled: true,
            tokenHash: hashBytes(Buffer.from(secret)),
            requests: doc?.requests ?? [],
          };
          await checkDestinationPath(input.path, '.repo-cloak/agent/token');
          await writeAtomic(
            join(input.path, '.repo-cloak/agent/token'),
            `${input.workspaceId}.${secret}\n`,
          );
          await write(doc);
        }
        await descriptor(doc);
        return doc;
      });
    },
    async authenticate(token: string) {
      const match = /^([A-Za-z0-9_-]{1,100})\.([a-f0-9]{64})$/.exec(token);
      if (!match) return undefined;
      const doc = await read(match[1] ?? '');
      if (!doc?.enabled) return undefined;
      const actual = Buffer.from(hashBytes(Buffer.from(match[2] ?? '')));
      const expected = Buffer.from(doc.tokenHash);
      return actual.length === expected.length && timingSafeEqual(actual, expected)
        ? doc
        : undefined;
    },
    async refreshDescriptors() {
      for (const name of await store.listFiles('agents')) {
        if (!name.endsWith('.json') || !agentId.safeParse(name.slice(0, -5)).success) continue;
        const doc = await read(name.slice(0, -5));
        if (doc?.enabled) {
          try {
            await descriptor(doc);
          } catch {
            /* An unsafe/missing workspace must not prevent other connections starting. */
          }
        }
      }
    },
  };
}
