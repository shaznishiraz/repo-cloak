import { confirm, editor, select } from '@inquirer/prompts';
import { scopeName } from '../core/profiles.js';
import type { SavedProfile } from '../core/profiles.js';
import { validateProfile } from '../core/rules.js';
import type { Profile } from '../core/rules.js';

export async function editProfile(profile: Profile): Promise<unknown> {
  const text = await editor({
    message: `Edit profile ${profile.name}`,
    default: JSON.stringify(profile, null, 2),
    waitForUserInput: false,
    file: { postfix: '.json', mode: 0o600 },
    validate(text) {
      try {
        validateProfile(JSON.parse(text));
        return true;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  return JSON.parse(text) as unknown;
}

export function chooseProfile(profiles: SavedProfile[]): Promise<SavedProfile> {
  return select({
    message: 'Which profile?',
    choices: profiles.map((profile) => ({
      name: `${profile.profile.name} (${scopeName(profile.scope)})`,
      value: profile,
    })),
  });
}

export function confirmDelete(profile: SavedProfile): Promise<boolean> {
  return confirm({
    message: `Delete ${scopeName(profile.scope)}:${profile.profile.name}?`,
    default: false,
  });
}
