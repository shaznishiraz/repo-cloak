import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import type { ProfileScope, SavedProfile } from '../core/profiles.js';
import { scopeName } from '../core/profiles.js';
import { validateProfile } from '../core/rules.js';
import type { Profile } from '../core/rules.js';
import type { createStore } from './store.js';

// I/O boundary shared by commands, the UI, and their fake-adapter tests.
export interface ProfileStore {
  list(scope: ProfileScope): Promise<SavedProfile[]>;
  save(scope: ProfileScope, profile: Profile, id?: string): Promise<SavedProfile>;
  remove(profile: SavedProfile): Promise<void>;
}

export function createProfileStore(store: ReturnType<typeof createStore>): ProfileStore {
  function directory(scope: ProfileScope) {
    if (scope.kind === 'global') return 'profiles';
    if (!/^[a-f0-9]{16}$/.test(scope.repoId)) throw new Error('Invalid repo id');
    return `repos/${scope.repoId}/profiles`;
  }
  function file(scope: ProfileScope, id: string) {
    if (!/^pf_[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid profile id');
    return `${directory(scope)}/${id}.json`;
  }
  async function list(scope: ProfileScope): Promise<SavedProfile[]> {
    const names = await store.listFiles(directory(scope));
    const profiles: SavedProfile[] = [];
    for (const name of names.filter((name) => name.endsWith('.json'))) {
      const id = name.slice(0, -5);
      const path = file(scope, id);
      profiles.push({
        id,
        scope,
        profile: validateProfile(await store.readSealed(path, 'profile'), path),
      });
    }
    return profiles.sort((a, b) => a.profile.name.localeCompare(b.profile.name));
  }
  async function update<T>(scope: ProfileScope, action: () => Promise<T>): Promise<T> {
    const path = join(store.root, directory(scope));
    await mkdir(path, { recursive: true, mode: 0o700 });
    const release = await lock(path, { retries: { retries: 8, minTimeout: 25, maxTimeout: 100 } });
    try {
      return await action();
    } finally {
      await release();
    }
  }
  return {
    list,
    async save(scope, value, id) {
      const profile = validateProfile(value);
      return update(scope, async () => {
        const profiles = await list(scope);
        if (id && !profiles.some((profile) => profile.id === id))
          throw new Error(`Profile ${id} no longer exists`);
        if (profiles.some((entry) => entry.profile.name === profile.name && entry.id !== id))
          throw new Error(`${scopeName(scope)}:${profile.name} already exists`);
        const saved = { id: id ?? `pf_${randomUUID()}`, scope, profile };
        await store.writeSealed(file(scope, saved.id), saved.id, 'profile', profile);
        return saved;
      });
    },
    async remove(saved) {
      await update(saved.scope, () => store.remove(file(saved.scope, saved.id)));
    },
  };
}
