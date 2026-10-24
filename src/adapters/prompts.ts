import { scopeName } from '../core/profiles.js';
import type { SavedProfile } from '../core/profiles.js';
import { validateProfile } from '../core/rules.js';
import type { Profile } from '../core/rules.js';

const loadPrompts = () => import('@inquirer/prompts');

export async function editProfile(profile: Profile): Promise<unknown> {
  const { editor } = await loadPrompts();
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

export async function chooseProfile(profiles: SavedProfile[]): Promise<SavedProfile> {
  const { select } = await loadPrompts();
  return select({
    message: 'Which profile?',
    choices: profiles.map((profile) => ({
      name: `${profile.profile.name} (${scopeName(profile.scope)})`,
      value: profile,
    })),
  });
}

export async function confirmDelete(profile: SavedProfile): Promise<boolean> {
  const { confirm } = await loadPrompts();
  return confirm({
    message: `Delete ${scopeName(profile.scope)}:${profile.profile.name}?`,
    default: false,
  });
}
