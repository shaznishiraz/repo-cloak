import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { createStore } from './store.js';
import { errorCode } from './atomic.js';
import { exists } from './files.js';
import { OperationError } from './ui-operations.js';
import { groupIdSchema } from '../core/groups.js';
import type { RepositoryGroup } from '../core/groups.js';
import { hashJson } from '../core/hash.js';

export type GroupLock = { assertHeld(): void; release(): Promise<void> };

export function createGroupStore(store = createStore()) {
  const relative = (id: string) => `groups/${groupIdSchema.parse(id)}.json`;
  async function read(id: string) {
    const file = relative(id);
    if (!(await exists(join(store.root, file)))) return undefined;
    const group = await store.readSealed(file, 'group');
    if (group.id !== id) throw new Error('Group identity does not match its record');
    return { ...group, revision: hashJson(group) };
  }
  /** For a hold that outlives one call. The holder should check assertHeld between steps. */
  async function acquire(): Promise<GroupLock> {
    const directory = join(store.root, 'groups');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let lost = false;
    let release: () => Promise<void>;
    try {
      release = await lock(directory, {
        retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
        // The default throws from a timer, which would take the whole dashboard down.
        onCompromised: () => {
          lost = true;
        },
      });
    } catch (error) {
      if (errorCode(error) !== 'ELOCKED') throw error;
      throw new OperationError('busy', 'Another group change or sync is running; try again', {
        cause: error,
      });
    }
    return {
      assertHeld() {
        if (lost) throw new OperationError('busy', 'The group lock was lost; the run stopped');
      },
      async release() {
        if (!lost) await release();
      },
    };
  }
  return {
    read,
    async list() {
      const groups = [];
      for (const file of await store.listFiles('groups')) {
        if (!file.endsWith('.json') || !groupIdSchema.safeParse(file.slice(0, -5)).success)
          continue;
        const group = await read(file.slice(0, -5));
        if (group) groups.push(group);
      }
      return groups.sort((a, b) => a.name.localeCompare(b.name));
    },
    async locked<T>(action: () => Promise<T>): Promise<T> {
      const held = await acquire();
      try {
        return await action();
      } finally {
        await held.release();
      }
    },
    acquire,
    async write(group: RepositoryGroup) {
      await store.writeSealed(relative(group.id), group.id, 'group', group);
      return { ...group, revision: hashJson(group) };
    },
    remove: (id: string) => store.remove(relative(id)),
  };
}
