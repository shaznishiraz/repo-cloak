import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { lock } from 'proper-lockfile';
import { parse } from 'smol-toml';
import { checkDestinationPath } from './files.js';
import { writeAtomic, errorCode } from './atomic.js';

const execute = promisify(execFile);
export function createAgentClientConfig(
  cliPath = fileURLToPath(new URL('./cli.js', import.meta.url)),
  run: (command: string, args: string[], cwd: string) => Promise<void> = async (
    command,
    args,
    cwd,
  ) => {
    await execute(command, args, {
      cwd,
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
  },
) {
  function info(workspaceId: string, path: string) {
    const name = `repo-cloak-${workspaceId.slice(0, 8)}`;
    const args = [cliPath, 'agent-mcp', '--workspace', path, '--workspace-id', workspaceId];
    return {
      name,
      command: process.execPath,
      args,
      codexTarget: join(path, '.codex/config.toml'),
      claudeTarget: `${join(homedir(), '.claude.json')} (local scope for this workspace)`,
      codex: `[mcp_servers.${JSON.stringify(name)}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\n`,
      claude: JSON.stringify(
        { mcpServers: { [name]: { command: process.execPath, args } } },
        null,
        2,
      ),
    };
  }
  return {
    info,
    async relocate(workspaceId: string, from: string, to: string) {
      const before = info(workspaceId, from);
      const after = info(workspaceId, to);
      const tomlPath = join(to, '.codex/config.toml');
      await checkDestinationPath(to, '.codex/config.toml');
      try {
        const text = await readFile(tomlPath, 'utf8');
        const servers = parse(text).mcp_servers as Record<string, { args?: unknown }> | undefined;
        if (JSON.stringify(servers?.[before.name]?.args) === JSON.stringify(before.args)) {
          const old = JSON.stringify(before.args);
          if (!text.includes(old))
            throw new Error(
              'Customized Repo Cloak MCP configuration must be updated before moving',
            );
          await writeAtomic(tomlPath, text.replace(old, JSON.stringify(after.args)));
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      await checkDestinationPath(to, '.mcp.json');
      const jsonPath = join(to, '.mcp.json');
      try {
        const config = JSON.parse(await readFile(jsonPath, 'utf8')) as {
          mcpServers?: Record<string, { args?: unknown }>;
        };
        const server = config.mcpServers?.[before.name];
        if (server && JSON.stringify(server.args) === JSON.stringify(before.args)) {
          server.args = after.args;
          await writeAtomic(jsonPath, JSON.stringify(config, null, 2) + '\n');
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    },
    async install(provider: 'codex' | 'claude', workspaceId: string, path: string) {
      const config = info(workspaceId, path);
      if (provider === 'codex') {
        await checkDestinationPath(path, '.codex/config.toml');
        const directory = join(path, '.codex');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const release = await lock(directory, { retries: 0 });
        try {
          let previous = '';
          try {
            previous = await readFile(config.codexTarget, 'utf8');
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
          const existing = parse(previous);
          const servers = existing.mcp_servers;
          if (servers && typeof servers === 'object' && Object.hasOwn(servers, config.name))
            return {
              status: 'existing',
              message: 'This workspace connection already exists and was left unchanged.',
            };
          const next = previous + '\n' + config.codex;
          parse(next); // Refuse invalid TOML without changing any existing bytes.
          await checkDestinationPath(path, '.codex/.gitignore');
          let ignores = '';
          try {
            ignores = await readFile(join(directory, '.gitignore'), 'utf8');
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
          if (!ignores.includes('# repo-cloak connection'))
            await writeAtomic(
              join(directory, '.gitignore'),
              ignores + '\n# repo-cloak connection\n/config.toml\n/.gitignore\n',
            );
          await writeAtomic(config.codexTarget, next);
        } finally {
          await release();
        }
        return {
          status: 'installed',
          message:
            'Added to this workspace’s Codex config. Trust this project and reload Codex to load its tools.',
        };
      }
      try {
        await run(provider, ['mcp', 'get', config.name], path);
        return {
          status: 'existing',
          message:
            'An entry with this name already exists and was left unchanged. Check it in your client.',
        };
      } catch (error) {
        const details = error as { code?: string | number; stderr?: string };
        if (details.code === 'ENOENT')
          throw new Error('Claude CLI is not installed. Copy its configuration instead.', {
            cause: error,
          });
        if (
          details.code !== 1 ||
          !/not found|no (?:mcp )?server|does not exist|not configured/i.test(details.stderr ?? '')
        )
          throw new Error(
            'Could not inspect existing client configuration. Nothing was changed; use Copy configuration.',
            { cause: error },
          );
      }
      try {
        await run(
          provider,
          [
            'mcp',
            'add',
            ...(provider === 'claude' ? ['--scope', 'local', '--transport', 'stdio'] : []),
            config.name,
            '--',
            config.command,
            ...config.args,
          ],
          path,
        );
      } catch {
        throw new Error(
          'Client configuration could not be added. Use Copy configuration to configure it manually.',
        );
      }
      return {
        status: 'installed',
        message: 'MCP connection added. Reload or restart the agent client to load its tools.',
      };
    },
  };
}
