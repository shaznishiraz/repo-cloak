/* global process */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createMcpClient } from './lib/mcp-client.mjs';
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
const server = spawn(
  process.execPath,
  [cli, 'agent-mcp', '--workspace', sandbox, '--workspace-id', 'ws_smoke'],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
);
const exited = new Promise((resolve) => server.once('exit', resolve));
const client = createMcpClient(server.stdin, server.stdout);
try {
  assert.equal((await client.initialize()).serverInfo.name, 'repo-cloak');
  assert.deepEqual(await client.request('ping'), {});
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    'cloak_probe_files',
    'cloak_request_files',
    'cloak_request_status',
    'cloak_workspace_info',
  ]);
  assert.equal((await client.callTool('cloak_workspace_info')).isError, true);
} finally {
  server.stdin.end();
  await exited;
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
  'dist/web/index.html',
  'dist/web/app.js',
  'dist/web/app.css',
  'dist/web/favicon.svg',
  'dist/web/favicon.ico',
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
    .filter((file) => /^dist\/web\/.*\.(js|css|html)$/.test(file.path))
    .reduce((sum, file) => sum + file.size, 0) <=
    160 * 1024,
  'The dashboard exceeds its 160 KB budget',
);
assert.deepEqual(pkg.dependencies['@modelcontextprotocol/sdk'], undefined);
for (const path of files)
  assert.ok(!/^(src|tests|archive|coverage)\//.test(path), `Unexpected package file: ${path}`);
process.stdout.write(`Package checks passed (${pack.files.length} files).\n`);
