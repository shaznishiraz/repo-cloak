/* global process */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const run = (args, cwd = root) =>
  exec(process.execPath, [cli, ...args], { cwd, windowsHide: true });

assert.equal((await run(['--version'])).stdout.trim(), pkg.version);
assert.equal(pkg.bin['repo-cloak'], 'dist/cli.js');
assert.equal(pkg.bin.cloak, 'dist/cli.js');
const help = (await run(['--help'])).stdout;
assert.match(help, /--port/);
assert.match(help, /--no-open/);
for (const command of ['push', 'pull', 'profile', 'status', 'schema', 'workspaces']) {
  await assert.rejects(run([command]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /unknown command|too many arguments/);
    return true;
  });
}
const sandbox = await mkdtemp(join(tmpdir(), 'cloak package MCP '));
const client = new Client({ name: 'package-smoke', version: '1' });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'agent-mcp', '--workspace', sandbox, '--workspace-id', 'ws_smoke'],
      stderr: 'pipe',
    }),
  );
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    'cloak_probe_files',
    'cloak_request_files',
    'cloak_request_status',
    'cloak_workspace_info',
  ]);
  assert.equal(
    (await client.callTool({ name: 'cloak_workspace_info', arguments: {} })).isError,
    true,
  );
} finally {
  await client.close();
  await rm(sandbox, { recursive: true, force: true });
}
for (const kind of ['profile', 'repo', 'manifest', 'config', 'group', 'agent']) {
  const schema = JSON.parse(await readFile(join(root, 'schemas', `${kind}.schema.json`), 'utf8'));
  assert.ok(schema.properties, `Missing ${kind} schema properties`);
}

assert.ok(process.env.npm_execpath, 'Run this check with npm run test:package');
const { stdout } = await exec(
  process.execPath,
  [process.env.npm_execpath, 'pack', '--dry-run', '--json'],
  { cwd: root, windowsHide: true },
);
const [pack] = JSON.parse(stdout);
const files = new Set(pack.files.map((file) => file.path));
for (const path of [
  'dist/cli.js',
  'dist/ui/index.html',
  'dist/ui/app.js',
  'dist/ui/app.css',
  'dist/ui/favicon.svg',
  'README.md',
  'LICENSE',
  'package.json',
  ...['profile', 'repo', 'manifest', 'config', 'group', 'agent'].map(
    (kind) => `schemas/${kind}.schema.json`,
  ),
]) {
  assert.ok(files.has(path), `Package is missing ${path}`);
}
assert.ok(
  pack.files
    .filter((file) => file.path.startsWith('dist/ui/'))
    .reduce((sum, file) => sum + file.size, 0) < 92_000,
);
for (const path of files)
  assert.ok(!/^(src|tests|archive|coverage)\//.test(path), `Unexpected package file: ${path}`);
process.stdout.write(`Package checks passed (${pack.files.length} files).\n`);
