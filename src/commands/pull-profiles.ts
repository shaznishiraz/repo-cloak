import type { SyncServices } from '../adapters/sync-services.js';
import type { Snapshot } from '../core/manifest.js';
import { mergeProfiles } from '../core/merge.js';
import type { SavedProfile } from '../core/profiles.js';
import type { RepoState } from '../core/pull.js';
import type { PullOptions } from './pull-setup.js';

export async function selectPullProfiles(
  services: SyncServices,
  repo: RepoState,
  options: PullOptions,
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
      if (matches.length > 1 && (options.yes || !services.interactive))
        throw new Error(`Profile ${value} is ambiguous; use global:${value} or repo:${value}`);
      profiles.push(matches.length > 1 ? await services.chooseProfile(matches) : first);
    }
    mergeProfiles(profiles);
    return profiles;
  }
  if (previous)
    return previous.data.profiles.map((ref) => {
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
          `Recorded profile ${ref.name} is missing; choose replacement profiles with --profile`,
        );
      return profile;
    });
  if (!services.interactive || options.yes)
    throw new Error('Choose profiles with --profile <name>');
  if (!available.length)
    throw new Error('No profiles found; create one with repo-cloak profile create');
  return services.chooseProfiles(available);
}
