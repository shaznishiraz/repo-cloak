import { checkbox, input, select } from '@inquirer/prompts';
import type { InteractiveAction, InteractiveIO } from '../commands/interactive.js';
import type { PullOptions } from '../commands/pull-setup.js';
import { mergeProfiles } from '../core/merge.js';
import type { SavedProfile } from '../core/profiles.js';
import { validateProfile } from '../core/rules.js';
import { runStatus } from '../commands/status.js';
import { createStatusIO } from './status.js';
import { editProfile } from './prompts.js';
import { createSyncServices } from './sync-services.js';

export function createInteractiveIO(
  write: (text: string) => void,
  ui: () => Promise<void>,
): InteractiveIO {
  const services = createSyncServices();
  return {
    services,
    write,
    ui,
    async action(side, hasWorkspaces) {
      return select<InteractiveAction>({
        message:
          side === 'workspace'
            ? 'Cloak workspace: what would you like to do?'
            : 'Source repository: what would you like to do?',
        choices: [
          ...(side === 'workspace' || hasWorkspaces
            ? [
                { name: 'Refresh workspace from source', value: 'extract' as const },
                { name: 'Restore workspace changes to source', value: 'restore' as const },
                { name: 'Show workspace status', value: 'status' as const },
              ]
            : []),
          ...(side === 'source'
            ? [{ name: 'Create a new cloak workspace', value: 'new' as const }]
            : []),
          {
            name: 'Open web dashboard',
            value: 'ui' as const,
          },
          { name: 'Exit', value: 'exit' as const },
        ],
      });
    },
    async profiles(available, suggested) {
      const profiles = [...available].sort(
        (a, b) => Number(suggested.includes(b.id)) - Number(suggested.includes(a.id)),
      );
      const values = await checkbox<SavedProfile | null>({
        message: 'Profiles to use',
        choices: [
          ...profiles.map((profile) => ({
            name: `${profile.profile.name} (${profile.scope.kind})`,
            value: profile,
            checked: suggested.includes(profile.id),
          })),
          { name: '+ Create a profile', value: null },
        ],
        validate(choices) {
          const values = choices.map((choice) => choice.value);
          if (values.includes(null)) return true;
          if (!values.length) return 'Choose at least one profile or create one';
          try {
            mergeProfiles(values.filter((value): value is SavedProfile => value !== null));
            return true;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
      });
      return {
        selected: values.filter((value): value is SavedProfile => value !== null),
        create: values.includes(null),
      };
    },
    async createProfile(repoId) {
      const name = await input({ message: 'Profile name', required: true });
      const scope = await select({
        message: 'Save profile for',
        choices: [
          { name: 'This repository', value: 'repo' },
          { name: 'All repositories', value: 'global' },
        ],
      });
      const profile = validateProfile(
        await editProfile(validateProfile({ kind: 'profile', schemaVersion: 1, name, rules: [] })),
      );
      return services.profiles.save(
        scope === 'repo' ? { kind: 'repo', repoId } : { kind: 'global' },
        profile,
      );
    },
    async selection(repo, profiles, tracked) {
      const kinds = await checkbox({
        message: 'What should be included?',
        required: true,
        choices: [
          ...(tracked.length
            ? [{ name: 'Previously tracked files', value: 'tracked', checked: true }]
            : []),
          { name: 'Files from the repository tree', value: 'files' },
          { name: 'Files changed in recent commits', value: 'commits' },
          { name: 'Working changes (staged, unstaged, and untracked)', value: 'working' },
          { name: 'Extra repository-relative paths', value: 'extra' },
        ],
      });
      const options: PullOptions = {};
      if (kinds.includes('tracked')) options.includeTracked = true;
      if (kinds.includes('files')) {
        const paths = services.files.filterPaths(
          await services.files.expandPaths(
            repo.path,
            repo.path,
            ['.'],
            profiles.map((profile) => profile.profile),
          ),
          profiles.map((profile) => profile.profile),
        );
        if (!paths.length) throw new Error('No eligible files found in this repository');
        const selected = await checkbox({
          message: 'Files (space to select, enter to continue)',
          required: true,
          choices: paths.sort().map((path) => ({
            name: `${'  '.repeat(path.split('/').length - 1)}${path}`,
            value: path,
          })),
        });
        options.files = [...(options.files ?? []), ...selected];
      }
      if (kinds.includes('commits')) {
        const commits = await services.git.recentCommits(repo.path);
        if (!commits.length)
          throw new Error('This repository has no commits; choose files or working changes');
        options.commits = await checkbox({
          message: 'Recent commits',
          required: true,
          choices: commits.map((commit) => ({
            name: `${commit.id.slice(0, 8)} ${commit.subject}`,
            value: commit.id,
          })),
        });
      }
      if (kinds.includes('working')) options.working = true;
      if (kinds.includes('extra')) {
        const paths = [...(options.files ?? [])];
        for (;;) {
          const path = await input({
            message: 'Extra path relative to the repository root (empty to finish)',
          });
          if (!path) break;
          paths.push(path);
        }
        if (paths.length) options.files = paths;
      }
      if (
        !options.files?.length &&
        !options.commits?.length &&
        !options.working &&
        !options.includeTracked
      )
        throw new Error('No files, commits or working changes selected');
      return options;
    },
    status: (root) => runStatus(createStatusIO(root)),
  };
}
