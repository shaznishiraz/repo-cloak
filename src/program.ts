import { Command, InvalidArgumentError } from 'commander';
import { version, description } from './package.js';
import { runUi } from './adapters/launcher.js';

export function createProgram(launch: typeof runUi = runUi): Command {
  const program = new Command()
    .name('repo-cloak')
    .description(description)
    .version(version, '-v, --version');
  const options = (command: Command) =>
    command
      .option('--port <number>', 'dashboard port (default: a free port)', (value: string) => {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
          throw new InvalidArgumentError('Port must be an integer from 1 to 65535');
        return Number(value);
      })
      .option('--no-open', 'print the dashboard address without opening a browser')
      .option('--next-ui', 'serve the rebuilt dashboard (also: REPO_CLOAK_UI=next)');
  const start = async (command: Command) => {
    const flags = command.optsWithGlobals<{ port?: number; open?: boolean; nextUi?: boolean }>();
    const write =
      program.configureOutput().writeOut ?? ((text: string) => process.stdout.write(text));
    await launch(write, flags);
  };
  options(program).action(() => start(program));
  const alias = options(program.command('ui').description('Open the local dashboard'));
  alias.action(() => start(alias));
  program
    .command('agent-mcp')
    .description('Serve scoped workspace file-request tools over MCP stdio')
    .requiredOption('--workspace <path>', 'cloak workspace directory')
    .requiredOption('--workspace-id <id>', 'expected cloak workspace identity')
    .action(async (flags: { workspace: string; workspaceId: string }) => {
      const { runAgentMcp } = await import('./adapters/agent-mcp.js');
      await runAgentMcp(flags.workspace, flags.workspaceId);
    });
  return program;
}
