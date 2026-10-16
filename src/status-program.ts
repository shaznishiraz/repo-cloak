import type { Command } from 'commander';
import { createStatusIO } from './adapters/status.js';
import { runStatus } from './commands/status.js';
import type { StatusIO } from './commands/status.js';

export type LoadStatus = () => Promise<StatusIO>;

export function addStatusCommand(program: Command, load?: LoadStatus): void {
  const command = program
    .command('status')
    .description('Show workspace changes since the last sync');
  command.action(async () => {
    const result = await runStatus(load ? await load() : createStatusIO());
    const write =
      program.configureOutput().writeOut ?? ((text: string) => process.stdout.write(text));
    if (command.optsWithGlobals<{ json?: boolean }>().json) {
      write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    let count = 0;
    for (const kind of ['added', 'modified', 'deleted'] as const) {
      for (const path of result[kind]) {
        write(`${kind}: ${path}\n`);
        count++;
      }
    }
    if (!count) write('Workspace is unchanged\n');
  });
}
