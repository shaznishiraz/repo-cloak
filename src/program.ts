import { addSyncCommands } from './sync-program.js';
import type { LoadSync } from './sync-program.js';
import { addStatusCommand } from './status-program.js';
import type { LoadStatus } from './status-program.js';
import { createRequire } from 'node:module';
import { Argument, Command } from 'commander';
import { printSchema } from './commands/schema.js';
import { documentKinds } from './core/schemas.js';
import type { DocumentKind } from './core/schemas.js';
import { addProfileCommands } from './profile-program.js';
import type { LoadProfiles } from './profile-program.js';
import { runInteractive } from './commands/interactive.js';
import { createInteractiveIO } from './adapters/interactive.js';
import type { InteractiveIO } from './commands/interactive.js';
import { addUiCommand, runUi } from './ui-program.js';

export type LoadInteractive = () => Promise<InteractiveIO>;

const require = createRequire(import.meta.url);
const { version, description } = require('../package.json') as {
  version: string;
  description: string;
};

export function createProgram(
  loadProfiles?: LoadProfiles,
  loadSync?: LoadSync,
  loadStatus?: LoadStatus,
  loadInteractive?: LoadInteractive,
): Command {
  const program = new Command()
    .name('repo-cloak')
    .description(description)
    .version(version, '-v, --version')
    .option('--json', 'output JSON for scripts')
    .option('-y, --yes', 'skip confirmations');
  program
    .command('schema')
    .description('Print a JSON Schema')
    .addArgument(new Argument('<kind>', 'document kind').choices(documentKinds))
    .action((kind: DocumentKind) => {
      printSchema(kind, (text) =>
        (program.configureOutput().writeOut ?? ((value) => process.stdout.write(value)))(text),
      );
    });
  addProfileCommands(program, loadProfiles);
  addSyncCommands(program, version, loadSync);
  addStatusCommand(program, loadStatus);
  addUiCommand(program);
  program.action(async () => {
    const { json, yes } = program.opts<{ json?: boolean; yes?: boolean }>();
    if (json || yes)
      throw new Error(
        'Interactive mode needs prompts; use an explicit command with --json or --yes',
      );
    if (!loadInteractive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      program.outputHelp();
      return;
    }
    const write =
      program.configureOutput().writeOut ?? ((text: string) => process.stdout.write(text));
    await runInteractive(
      loadInteractive ? await loadInteractive() : createInteractiveIO(write, () => runUi(write)),
      version,
    );
  });
  return program;
}
