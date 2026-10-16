import { Option } from 'commander';
import type { Command } from 'commander';
import { createProfileCommands } from './commands/profile.js';
import type { ProfileOptions } from './commands/profile.js';
import { createProfileContext } from './adapters/profile-context.js';
import { scopeName } from './core/profiles.js';
import type { SavedProfile } from './core/profiles.js';

type ProfileCommands = ReturnType<typeof createProfileCommands>;
export type LoadProfiles = (globalOnly: boolean) => Promise<ProfileCommands>;

async function loadProfiles(globalOnly: boolean) {
  return createProfileCommands(await createProfileContext(globalOnly));
}

export function addProfileCommands(program: Command, load: LoadProfiles = loadProfiles): void {
  const profile = program
    .command('profile')
    .description('Manage encrypted rule profiles')
    .addOption(new Option('--global', 'use global profiles').conflicts('repo'))
    .addOption(new Option('--repo', 'use profiles for this repository').conflicts('global'));

  function write(value: string) {
    const output =
      program.configureOutput().writeOut ?? ((text: string) => process.stdout.write(text));
    output(`${value}\n`);
  }
  function json(value: unknown) {
    write(JSON.stringify(value, null, 2));
  }
  function summary(saved: SavedProfile) {
    return {
      id: saved.id,
      name: saved.profile.name,
      scope: scopeName(saved.scope),
      rules: saved.profile.rules.length,
    };
  }
  async function loadContext(command: Command) {
    const flags = command.optsWithGlobals<{
      global?: boolean;
      repo?: boolean;
      yes?: boolean;
      json?: boolean;
    }>();
    const options: ProfileOptions = {};
    if (flags.global) options.scope = 'global';
    if (flags.repo) options.scope = 'repo';
    if (flags.yes) options.yes = true;
    return { commands: await load(Boolean(flags.global)), options, json: Boolean(flags.json) };
  }
  function report(saved: SavedProfile, verb: string, asJson: boolean) {
    if (asJson) json(summary(saved));
    else write(`${verb} ${saved.profile.name} (${scopeName(saved.scope)})`);
  }

  const list = profile.command('list').description('List global and current repository profiles');
  list.action(async () => {
    const context = await loadContext(list);
    const profiles = await context.commands.list(context.options);
    if (context.json) json(profiles.map(summary));
    else if (!profiles.length) write('No profiles found.');
    else
      for (const saved of profiles)
        write(
          `${saved.profile.name} (${scopeName(saved.scope)}) — ${saved.profile.rules.length} rules`,
        );
  });

  const show = profile.command('show <name>').description('Show a decrypted profile as JSON');
  show.action(async (name: string) => {
    const context = await loadContext(show);
    json(await context.commands.show(name, context.options));
  });

  const create = profile.command('create <name>').description('Create a profile in your editor');
  create.action(async (name: string) => {
    const context = await loadContext(create);
    report(await context.commands.create(name, context.options), 'Created', context.json);
  });

  const edit = profile.command('edit <name>').description('Edit and validate a decrypted profile');
  edit.action(async (name: string) => {
    const context = await loadContext(edit);
    report(await context.commands.edit(name, context.options), 'Saved', context.json);
  });

  const remove = profile
    .command('delete <name>')
    .description('Delete a profile after confirmation');
  remove.action(async (name: string) => {
    const context = await loadContext(remove);
    const saved = await context.commands.remove(name, context.options);
    if (saved) report(saved, 'Deleted', context.json);
    else if (context.json) json({ deleted: false });
    else write('Cancelled.');
  });

  const exportProfile = profile
    .command('export <name>')
    .description('Export a decrypted profile as JSON');
  exportProfile.action(async (name: string) => {
    const context = await loadContext(exportProfile);
    json(await context.commands.show(name, context.options));
  });

  const importProfile = profile
    .command('import <file>')
    .description('Import JSON from a file or - for stdin');
  importProfile.action(async (file: string) => {
    const context = await loadContext(importProfile);
    report(await context.commands.import(file, context.options), 'Imported', context.json);
  });

  const check = profile
    .command('check <names...>')
    .description('Check profiles for conflicting rules');
  check.action(async (names: string[]) => {
    const context = await loadContext(check);
    const result = await context.commands.check(names, context.options);
    if (context.json) json(result);
    else write(`Valid: ${result.profiles} profiles, ${result.rules} active rules.`);
  });
}
