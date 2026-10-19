import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProfileStore } from '../../src/adapters/profiles.js';
import { createStore } from '../../src/adapters/store.js';
import { validateProfile } from '../../src/core/rules.js';
import { profile } from '../fixtures.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((p) => rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cloak profiles '));
  roots.push(root);
  return { root, profiles: createProfileStore(createStore(root)) };
}
const global = { kind: 'global' } as const;
const repo = { kind: 'repo', repoId: 'a'.repeat(16) } as const;
describe('profile storage', () => {
  it('lists a missing scope without creating anything', async () => {
    const { root, profiles } = await fixture();
    expect(await profiles.list(global)).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });
  it('stores profiles under opaque ids and keeps scopes separate', async () => {
    const { root, profiles } = await fixture();
    const first = await profiles.save(global, validateProfile(profile));
    await profiles.save(repo, validateProfile(profile));
    expect(first.id).toMatch(/^pf_/);
    const file = await readFile(join(root, 'profiles', `${first.id}.json`), 'utf8');
    expect(file).not.toContain('Acme');
    expect(file).not.toContain('acme');
    expect(await profiles.list(global)).toEqual([first]);
    expect(await profiles.list(repo)).toHaveLength(1);
  });
  it('rejects duplicate names without overwriting, while edits keep the id', async () => {
    const { profiles } = await fixture();
    const first = await profiles.save(global, validateProfile(profile));
    await expect(profiles.save(global, validateProfile(profile))).rejects.toThrow(
      /acme.*already exists/,
    );
    const updated = await profiles.save(
      global,
      validateProfile({ ...profile, name: 'renamed', future: true }),
      first.id,
    );
    expect(updated.id).toBe(first.id);
    expect(await profiles.list(global)).toEqual([updated]);
    await profiles.remove(updated);
    expect(await profiles.list(global)).toEqual([]);
  });
  it('serializes duplicate-name checks across independent writers', async () => {
    const { root, profiles } = await fixture();
    const other = createProfileStore(createStore(root));
    const results = await Promise.allSettled([
      profiles.save(global, validateProfile(profile)),
      other.save(global, validateProfile(profile)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await profiles.list(global)).toHaveLength(1);
    expect((await readdir(root)).some((name) => name.endsWith('.lock'))).toBe(false);
  });
  it('rejects invalid data before writing and refuses to edit missing profiles', async () => {
    const { root, profiles } = await fixture();
    await expect(
      profiles.save(global, { ...validateProfile(profile), name: ' ' }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    await expect(profiles.save(global, validateProfile(profile), 'pf_missing')).rejects.toThrow(
      /no longer exists/,
    );
  });
});
