import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { InteractiveAction, InteractiveIO } from '../commands/interactive.js';
import type { PullOptions } from '../commands/pull-setup.js';
import { mergeProfiles } from '../core/merge.js';
import type { SavedProfile } from '../core/profiles.js';
import { validateProfile } from '../core/rules.js';
import { runStatus } from '../commands/status.js';
import { createStatusIO } from './status.js';
import { editProfile } from './prompts.js';
import { createSyncServices } from './sync-services.js';

const loadPrompts = () => import('@inquirer/prompts');

/** Resolve a typed path: relative to the current directory, with a leading ~ for home. */
function typedPath(cwd: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\'))
    return resolve(homedir(), trimmed.slice(2));
  return resolve(cwd, trimmed);
}
async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createInteractiveIO(
  write: (text: string) => void,
  ui: (cwd: string) => Promise<void>,
): InteractiveIO {
  const services = createSyncServices();
  return {
    services,
    write,
    ui,
    async source(current, known) {
      const { select, input } = await loadPrompts();
      const others = known.filter((path) => path !== current?.path);
      let path: string | null = null;
      if (current || others.length)
        path = await select<string | null>({
          message: 'Source repository',
          default: current?.path ?? null,
          choices: [
            ...(current
              ? [{ name: `${current.path} (current directory)`, value: current.path }]
              : []),
            ...others.map((path) => ({ name: path, value: path })),
            { name: 'Enter a path...', value: null },
          ],
        });
      if (path) return path;
      const typed = await input({
        message: 'Path to the source repository',
        async validate(value) {
          if (!value.trim()) return 'Enter a path';
          const resolved = typedPath(services.cwd, value);
          return (await services.git.findRepo(resolved).catch(() => undefined))
            ? true
            : `Not a Git repository: ${resolved}`;
        },
      });
      return typedPath(services.cwd, typed);
    },
    async worktree(worktrees, current) {
      const { select } = await loadPrompts();
      const available: typeof worktrees = [];
      for (const tree of worktrees) if (await present(tree.path)) available.push(tree);
      const main = available[0]?.path;
      if (!main) throw new Error('No worktree of this repository exists on disk');
      if (available.length === 1) return main;
      return select({
        message: 'Worktree',
        default: current && available.some((tree) => tree.path === current) ? current : main,
        choices: available.map((tree) => ({
          name: `${tree.branch ?? '(detached HEAD)'}  ${tree.path}${tree.path === main ? '  (main worktree)' : ''}`,
          value: tree.path,
        })),
      });
    },
    async action(side, hasWorkspaces) {
      const { select } = await loadPrompts();
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
            ? [{ name: 'Create a cloak workspace in the CLI', value: 'new' as const }]
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
      const { checkbox } = await loadPrompts();
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
      const { input, select } = await loadPrompts();
      const name = await input({ message: 'Profile name', required: true });
      const scope = await select({
        message: 'Save profile for',
        choices: [
          { name: 'This repository', value: 'repo' },
          { name: 'All repositories', value: 'global' },
        ],
      });
      const profile = validateProfile(
        await editProfile(
          validateProfile({
            kind: 'profile',
            schemaVersion: 1,
            name,
            rules: [],
            exclude: [],
            include: [],
          }),
        ),
      );
      return services.profiles.save(
        scope === 'repo' ? { kind: 'repo', repoId } : { kind: 'global' },
        profile,
      );
    },
    async selection(repo, profiles, tracked) {
      const { checkbox, input } = await loadPrompts();
      const kinds = await checkbox({
        message: 'What should be included?',
        required: true,
        choices: [
          ...(tracked.length
            ? [{ name: 'Previously tracked files', value: 'tracked', checked: true }]
            : []),
          { name: 'Files from the repository tree', value: 'files' },
          { name: 'Files changed in recent commits', value: 'commits' },
          { name: 'Files changed in specific commits (type IDs or refs)', value: 'commit-ids' },
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
      if (kinds.includes('commit-ids')) {
        const ids = [...(options.commits ?? [])];
        const typed = new Set<string>();
        for (;;) {
          const ref = (
            await input({
              message: 'Commit ID, branch or tag (empty to finish)',
              async validate(value) {
                const trimmed = value.trim();
                if (!trimmed) return typed.size ? true : 'Enter at least one commit';
                try {
                  await services.git.resolveCommit(repo.path, trimmed);
                  return true;
                } catch {
                  return `Not a commit in this repository: ${trimmed}`;
                }
              },
            })
          ).trim();
          if (!ref) break;
          const sha = await services.git.resolveCommit(repo.path, ref);
          typed.add(sha);
          if (!ids.includes(sha)) ids.push(sha);
        }
        options.commits = ids;
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
