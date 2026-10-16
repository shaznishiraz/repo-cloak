import type { Command } from 'commander';
import { createSyncServices } from './adapters/sync-services.js';
import { createSyncCommand } from './commands/sync.js';
import type { PullOptions } from './commands/pull-setup.js';
import { listWorkspaces } from './commands/workspaces.js';

type SyncCommand = ReturnType<typeof createSyncCommand>;
export type LoadSync = () => Promise<SyncCommand>;

export function addSyncCommands(program: Command, version: string, load?: LoadSync): void {
  const collect = (value: string, previous: string[]) => [...previous, value];
  for (const direction of ['push', 'pull'] as const) {
    const command = program
      .command(direction)
      .description(
        direction === 'push' ? 'Send files to the other side' : 'Bring files into this side',
      )
      .option(
        '--profile <name>',
        'profile name or global:name / repo:name; repeatable',
        collect,
        [],
      )
      .option('--files <paths...>', 'explicit files or directories', collect, [])
      .option('--commit <ref>', 'files changed by a commit; repeatable', collect, [])
      .option('--working', 'include staged, unstaged and untracked changes')
      .option('--to <workspace>', 'workspace id, name, or destination path (source only)')
      .option('--worktree <path>', 'source worktree override (workspace only)')
      .option('--dry-run', 'preview without writing files');
    command
      .option('--from <workspace>', 'workspace id, name, or path to restore (source only)')
      .option('--force', 'overwrite source conflicts')
      .option('--skip-conflicts', 'restore files without source conflicts');
    command
      .option('--new-worktree <branch>', 'create a restore target on a new branch (workspace only)')
      .option('--base <ref>', 'base commit for --new-worktree (default: extracted commit)')
      .option('--path <directory>', 'destination directory for --new-worktree');
    command.action(async () => {
      const flags = command.optsWithGlobals<{
        profile: string[];
        files: string[];
        commit: string[];
        working?: boolean;
        to?: string;
        worktree?: string;
        dryRun?: boolean;
        yes?: boolean;
        json?: boolean;
        from?: string;
        force?: boolean;
        skipConflicts?: boolean;
        newWorktree?: string;
        base?: string;
        path?: string;
      }>();
      const options: PullOptions = {
        profiles: flags.profile,
        files: flags.files,
        commits: flags.commit,
      };
      if (flags.working) options.working = true;
      if (flags.to) options.to = flags.to;
      if (flags.worktree) options.worktree = flags.worktree;
      if (flags.dryRun) options.dryRun = true;
      if (flags.yes) options.yes = true;
      if (flags.from) options.from = flags.from;
      if (flags.force) options.force = true;
      if (flags.skipConflicts) options.skipConflicts = true;
      if (flags.newWorktree) options.newWorktree = flags.newWorktree;
      if (flags.base) options.base = flags.base;
      if (flags.path) options.path = flags.path;
      const run = load ? await load() : createSyncCommand(createSyncServices(), version);
      const result = await run(direction, options);
      const write =
        program.configureOutput().writeOut ?? ((text: string) => process.stdout.write(text));
      if (flags.json) write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        write(
          `${result.status}: ${result.writes.length} files to write, ${result.deletes.length} to remove\n${result.workspace}\n`,
        );
        for (const warning of result.warnings) write(`Warning: ${warning}\n`);
        if (result.profileChanges.length)
          write(`Changed profiles: ${result.profileChanges.join(', ')}\n`);
      }
    });
  }
  const workspaces = program
    .command('workspaces')
    .description('List linked workspaces, most recent first');
  workspaces.action(async () => {
    const result = await listWorkspaces(createSyncServices());
    const write =
      program.configureOutput().writeOut ?? ((text: string) => process.stdout.write(text));
    if (workspaces.optsWithGlobals<{ json?: boolean }>().json)
      write(`${JSON.stringify(result, null, 2)}\n`);
    else if (!result.length) write('No linked workspaces\n');
    else
      for (const item of result)
        write(
          `${item.id}  ${item.path}  ${item.origin?.branch ?? '(detached)'} -> ${item.target?.branch ?? '(detached)'}\n`,
        );
  });
}
