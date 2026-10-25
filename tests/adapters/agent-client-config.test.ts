import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createAgentClientConfig } from '../../src/adapters/agent-client-config.js';

it('adds only workspace-scoped Codex configuration and preserves existing entries and comments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak config $literal '));
  try {
    await mkdir(join(root, '.codex'));
    const file = join(root, '.codex/config.toml');
    const previous =
      '# Keep this comment\nmodel = "chosen-model"\n[mcp_servers.other]\ncommand = "other-tool"\n';
    await writeFile(file, previous);
    const config = createAgentClientConfig('/app/repo cloak/cli.js');
    expect((await config.install('codex', 'ws_id', root)).status).toBe('installed');
    const next = await readFile(file, 'utf8');
    expect(next.startsWith(previous)).toBe(true);
    expect(next).toContain('[mcp_servers."repo-cloak-ws_id"]');
    expect(next).toContain('"--workspace-id","ws_id"');
    expect((await config.install('codex', 'ws_id', root)).status).toBe('existing');
    expect(await readFile(file, 'utf8')).toBe(next);
    await writeFile(file, 'invalid = [');
    await expect(config.install('codex', 'another', root)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('invalid = [');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('uses Claude local-scope commands with literal arguments and leaves existing entries unchanged', async () => {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  let exists = false;
  const config = createAgentClientConfig('/app/repo cloak/cli.js', async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (args[1] === 'get' && !exists)
      throw Object.assign(new Error('Missing'), {
        code: 1,
        stderr: 'No MCP server found with name',
      });
  });
  const path = '/cloaks/path with $literal';
  expect((await config.install('claude', 'ws_id', path)).status).toBe('installed');
  expect(calls[1]).toEqual({
    command: 'claude',
    args: [
      'mcp',
      'add',
      '--scope',
      'local',
      '--transport',
      'stdio',
      'repo-cloak-ws_id',
      '--',
      process.execPath,
      '/app/repo cloak/cli.js',
      'agent-mcp',
      '--workspace',
      path,
      '--workspace-id',
      'ws_id',
    ],
    cwd: path,
  });
  exists = true;
  calls.length = 0;
  expect((await config.install('claude', 'ws_id', path)).status).toBe('existing');
  expect(calls).toHaveLength(1);
});

it('retargets moved workspace MCP entries while preserving comments and unrelated settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak move config '));
  const from = join(root, 'before');
  const to = join(root, 'after');
  try {
    await mkdir(from);
    const config = createAgentClientConfig('/app/cli.js');
    await config.install('codex', 'ws_id', from);
    const before = config.info('ws_id', from);
    const file = join(from, '.codex/config.toml');
    const original = '# Keep this comment\n' + (await readFile(file, 'utf8'));
    await writeFile(file, original + '\n[mcp_servers.other]\ncommand = "keep-me"\n');
    await writeFile(join(from, '.mcp.json'), before.claude);
    await rename(from, to);
    await config.relocate('ws_id', from, to);
    const moved = await readFile(join(to, '.codex/config.toml'), 'utf8');
    expect(moved).toContain('# Keep this comment');
    expect(moved).toContain('command = "keep-me"');
    expect(moved).toContain(JSON.stringify(config.info('ws_id', to).args));
    const claude = JSON.parse(await readFile(join(to, '.mcp.json'), 'utf8'));
    expect(claude.mcpServers[before.name].args).toEqual(config.info('ws_id', to).args);
    const custom = original.replace(
      JSON.stringify(before.args),
      '[\n' + before.args.map((arg) => JSON.stringify(arg)).join(',\n') + '\n]',
    );
    await writeFile(join(to, '.codex/config.toml'), custom);
    await expect(config.relocate('ws_id', from, to)).rejects.toThrow(/Customized/);
    expect(await readFile(join(to, '.codex/config.toml'), 'utf8')).toBe(custom);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
