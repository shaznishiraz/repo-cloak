import { findRepo } from './git.js';
import { readJson } from './input.js';
import { createProfileStore } from './profiles.js';
import { chooseProfile, confirmDelete, editProfile } from './prompts.js';
import { createStore } from './store.js';

export async function createProfileContext(globalOnly: boolean) {
  const repo = globalOnly ? undefined : await findRepo(process.cwd());
  return {
    store: createProfileStore(createStore()),
    repoId: repo?.repoId,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    read: readJson,
    edit: editProfile,
    choose: chooseProfile,
    confirm: confirmDelete,
  };
}
