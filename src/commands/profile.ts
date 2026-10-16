import type { ProfileStore } from '../adapters/profiles.js';
import { mergeProfiles } from '../core/merge.js';
import type { ProfileScope, SavedProfile } from '../core/profiles.js';
import { validateProfile } from '../core/rules.js';
import type { Profile } from '../core/rules.js';

export type ProfileOptions = { scope?: 'global' | 'repo'; yes?: boolean };

export interface ProfileIO {
  store: ProfileStore;
  repoId: string | undefined;
  interactive: boolean;
  read(file: string): Promise<unknown>;
  edit(profile: Profile): Promise<unknown>;
  choose(profiles: SavedProfile[]): Promise<SavedProfile>;
  confirm(profile: SavedProfile): Promise<boolean>;
}

export function createProfileCommands(io: ProfileIO) {
  function repoScope(): ProfileScope {
    if (!io.repoId)
      throw new Error('This command needs a Git repository; use --global for global profiles');
    return { kind: 'repo', repoId: io.repoId };
  }
  function writeScope(options: ProfileOptions): ProfileScope {
    return options.scope === 'global' ? { kind: 'global' } : repoScope();
  }
  async function list(options: ProfileOptions): Promise<SavedProfile[]> {
    const scopes: ProfileScope[] = options.scope
      ? [options.scope === 'global' ? { kind: 'global' } : repoScope()]
      : [{ kind: 'global' }, ...(io.repoId ? [repoScope()] : [])];
    return (await Promise.all(scopes.map((scope) => io.store.list(scope)))).flat();
  }
  async function find(name: string, options: ProfileOptions): Promise<SavedProfile> {
    const matches = (await list(options)).filter((entry) => entry.profile.name === name);
    const first = matches[0];
    if (!first) throw new Error(`Profile ${name} was not found`);
    if (matches.length === 1) return first;
    if (options.yes || !io.interactive)
      throw new Error(`Profile ${name} exists in both scopes; specify --global or --repo`);
    return io.choose(matches);
  }
  function requireEditor(options: ProfileOptions) {
    if (!io.interactive || options.yes)
      throw new Error(
        'Profile create/edit needs an interactive terminal; use profile import <file|-> for scripts',
      );
  }
  return {
    list,
    async show(name: string, options: ProfileOptions): Promise<Profile> {
      return (await find(name, options)).profile;
    },
    async create(name: string, options: ProfileOptions): Promise<SavedProfile> {
      requireEditor(options);
      const scope = writeScope(options);
      if ((await io.store.list(scope)).some((entry) => entry.profile.name === name))
        throw new Error(`Profile ${name} already exists`);
      const profile = validateProfile({
        $schema: 'https://unpkg.com/repo-cloak-cli@2/schemas/profile.schema.json',
        kind: 'profile',
        schemaVersion: 1,
        name,
        rules: [],
        extensions: {},
      });
      return io.store.save(scope, validateProfile(await io.edit(profile)));
    },
    async edit(name: string, options: ProfileOptions): Promise<SavedProfile> {
      requireEditor(options);
      const saved = await find(name, options);
      return io.store.save(saved.scope, validateProfile(await io.edit(saved.profile)), saved.id);
    },
    async remove(name: string, options: ProfileOptions): Promise<SavedProfile | undefined> {
      const saved = await find(name, options);
      if (!options.yes) {
        if (!io.interactive)
          throw new Error('Deleting a profile needs confirmation; pass --yes to delete it');
        if (!(await io.confirm(saved))) return undefined;
      }
      await io.store.remove(saved);
      return saved;
    },
    async import(file: string, options: ProfileOptions): Promise<SavedProfile> {
      const scope = writeScope(options);
      return io.store.save(scope, validateProfile(await io.read(file), file));
    },
    async check(names: string[], options: ProfileOptions) {
      const profiles: SavedProfile[] = [];
      for (const name of names) profiles.push(await find(name, options));
      const rules = mergeProfiles(profiles);
      return { profiles: profiles.length, rules: rules.length };
    },
  };
}
