import type { SyncServices } from '../adapters/sync-services.js';
import type { Snapshot } from '../core/manifest.js';
import { mergeProfiles } from '../core/merge.js';
import { expandProfiles } from '../core/profile-graph.js';
import type { SavedProfile } from '../core/profiles.js';
import type { RepoState } from '../core/pull.js';
import type { SyncOptions } from './pull-setup.js';

export async function selectPullProfiles(
  services: SyncServices,
  repo: RepoState,
  options: SyncOptions,
  previous?: Snapshot,
): Promise<SavedProfile[]> {
  const available = (
    await Promise.all([
      services.profiles.list({ kind: 'global' }),
      services.profiles.list({ kind: 'repo', repoId: repo.repoId }),
    ])
  ).flat();
  if (options.profiles?.length) {
    const profiles: SavedProfile[] = [];
    for (const value of options.profiles) {
      const qualified = /^(global|repo):(.*)$/.exec(value);
      const matches = available.filter(
        (profile) =>
          (!qualified || profile.scope.kind === qualified[1]) &&
          (profile.id === (qualified?.[2] ?? value) ||
            profile.profile.name === (qualified?.[2] ?? value)),
      );
      const first = matches[0];
      if (!first) throw new Error(`Profile ${value} was not found`);
      if (matches.length > 1)
        throw new Error(
          `Profile ${value} is ambiguous; select a profile with its scope in the dashboard`,
        );
      profiles.push(first);
    }
    const expanded = expandProfiles(profiles, available);
    mergeProfiles(expanded);
    return expanded;
  }
  if (previous) {
    const recorded = previous.data.profiles.map((ref) => {
      const profile = available.find(
        (profile) =>
          profile.id === ref.id &&
          profile.scope.kind === ref.scope.kind &&
          (profile.scope.kind !== 'repo' ||
            ref.scope.kind !== 'repo' ||
            profile.scope.repoId === ref.scope.repoId),
      );
      if (!profile)
        throw new Error(
          `Recorded profile ${ref.name} is missing; select replacement profiles in the dashboard`,
        );
      return profile;
    });
    return expandProfiles(recorded, available);
  }
  throw new Error('Select at least one profile in the dashboard');
}
