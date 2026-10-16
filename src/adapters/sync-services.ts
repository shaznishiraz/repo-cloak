import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import type { SavedProfile } from '../core/profiles.js';
import type { PullPlan } from '../core/pull.js';
import * as files from './files.js';
import * as git from './git.js';
import { createProfileStore } from './profiles.js';
import { createStore } from './store.js';
import { createSyncStore } from './sync-store.js';
import { createWorkspaceWriter } from './workspace.js';
import { createSourceWriter } from './source-writer.js';
import type { PushPlan } from '../core/push.js';

export function createSyncServices(cwd = process.cwd(), store = createStore()) {
  return {
    cwd: resolve(cwd),
    store: createSyncStore(store),
    profiles: createProfileStore(store),
    files,
    git,
    writeWorkspace: createWorkspaceWriter(),
    writeSource: createSourceWriter(),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    now: () => new Date().toISOString(),
    newId: randomUUID,
    async chooseProfiles(profiles: SavedProfile[]): Promise<SavedProfile[]> {
      return checkbox({
        message: 'Profiles to use',
        required: true,
        choices: profiles.map((profile) => ({
          name: `${profile.profile.name} (${profile.scope.kind})`,
          value: profile,
        })),
      });
    },
    async chooseWorkspace(paths: string[]): Promise<string> {
      return select({
        message: 'Which workspace?',
        choices: paths.map((path) => ({ name: path, value: path })),
      });
    },
    async chooseProfile(profiles: SavedProfile[]): Promise<SavedProfile> {
      return select({
        message: 'Which profile?',
        choices: profiles.map((profile) => ({
          name: `${profile.profile.name} (${profile.scope.kind})`,
          value: profile,
        })),
      });
    },
    async workspacesRoot(): Promise<string> {
      return input({ message: 'Where should cloak workspaces live?', required: true });
    },
    async confirmProfiles(plan: PullPlan): Promise<boolean> {
      process.stderr.write(
        `Changed profiles: ${plan.profileChanges.join(', ')}\nRules before:\n${JSON.stringify(plan.previousRules, null, 2)}\nRules now:\n${JSON.stringify(plan.data.rules, null, 2)}\n`,
      );
      return confirm({ message: 'Refresh using these changed profiles?', default: false });
    },
    async confirmPull(plan: PullPlan, destination?: string): Promise<boolean> {
      const matches = plan.preview.filter((match) => match.status === 'replaced');
      if (destination) process.stderr.write(`Workspace: ${destination}\n`);
      process.stderr.write(
        `${plan.writes.length} files to write, ${plan.deletes.length} files to remove\n${matches.length} replacements, ${matches.filter((match) => match.kind === 'secret').length} secrets redacted\n${plan.warnings.join('\n')}\n`,
      );
      return confirm({ message: 'Apply this pull?', default: true });
    },
    async confirmPush(plan: PushPlan): Promise<boolean> {
      process.stderr.write(
        `${plan.writes.length} files to write, ${plan.deletes.length} files to delete in the source\n`,
      );
      for (const path of plan.deletes) process.stderr.write(`Delete: ${path}\n`);
      for (const path of plan.conflicts) process.stderr.write(`Skip conflict: ${path}\n`);
      return confirm({ message: 'Restore these changes to the source?', default: false });
    },
  };
}
export type SyncServices = ReturnType<typeof createSyncServices>;
