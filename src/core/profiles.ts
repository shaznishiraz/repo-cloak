import type { Profile } from './rules.js';

export type ProfileScope = { kind: 'global' } | { kind: 'repo'; repoId: string };

export type SavedProfile = {
  id: string;
  scope: ProfileScope;
  profile: Profile;
};

export function scopeName(scope: ProfileScope): string {
  return scope.kind === 'global' ? 'global' : `repo:${scope.repoId}`;
}
