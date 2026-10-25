import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { createStore } from './store.js';
import { exists } from './files.js';
import { groupIdSchema } from '../core/groups.js';
import type { RepositoryGroup } from '../core/groups.js';
import { hashJson } from '../core/hash.js';

export function createGroupStore(store = createStore()) {
  const relative = (id: string) => `groups/${groupIdSchema.parse(id)}.json`;
  async function read(id: string) {
    const file = relative(id);
    if (!(await exists(join(store.root, file)))) return undefined;
    const group = await store.readSealed(file, 'group');
    if (group.id !== id) throw new Error('Group identity does not match its record');
    return { ...group, revision: hashJson(group) };
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
      const directory = join(store.root, 'groups');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await lock(directory, {
        retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
      });
      try {
        return await action();
      } finally {
        await release();
      }
    },
    async write(group: RepositoryGroup) {
      await store.writeSealed(relative(group.id), group.id, 'group', group);
      return { ...group, revision: hashJson(group) };
    },
    remove: (id: string) => store.remove(relative(id)),
  };
}
