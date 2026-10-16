import type { Command } from 'commander';
import openBrowser from 'open';
import { createDashboard } from './commands/dashboard.js';
import { createStore } from './adapters/store.js';
import { startUiSession } from './adapters/ui-session.js';

export async function runUi(
  write: (text: string) => void,
  options: { port?: number; open?: boolean; json?: boolean } = {},
) {
  const store = createStore();
  const dashboard = createDashboard(store);
  const context = await dashboard.context();
  const session = await startUiSession(store.root, dashboard, options.port);
  const fragment = new URLSearchParams({ token: session.token });
  if (context.repoId) fragment.set('repo', context.repoId);
  if (context.workspaceId) fragment.set('workspace', context.workspaceId);
  const url = `http://127.0.0.1:${session.port}/#${fragment}`;
  if (!session.reused) {
    const stop = () => {
      void session
        .close()
        .catch((error: unknown) => {
          process.stderr.write(
            `Could not close dashboard: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = 1;
        })
        .finally(() => {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  if (options.json) write(`${JSON.stringify({ url, reused: session.reused })}\n`);
  else {
    write(`${session.reused ? 'Using the running dashboard' : 'Dashboard running'} at ${url}\n`);
    if (!session.reused) write('Press Ctrl+C to stop.\n');
  }
  if (options.open !== false) {
    try {
      await openBrowser(url, { wait: false });
    } catch {
      process.stderr.write('Could not open a browser automatically. Open the address above.\n');
    }
  }
}

export function addUiCommand(program: Command, run = runUi): void {
  const command = program
    .command('ui')
    .description('Open the machine-wide local dashboard')
    .option('--port <number>', 'listen on this port (default: a free port)', (value: string) => {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
        throw new Error('Port must be an integer from 1 to 65535');
      return Number(value);
    })
    .option('--no-open', 'print the address without opening a browser');
  command.action(async () => {
    const write =
      program.configureOutput().writeOut ?? ((text: string) => process.stdout.write(text));
    await run(write, command.optsWithGlobals<{ port?: number; open: boolean; json?: boolean }>());
  });
}
