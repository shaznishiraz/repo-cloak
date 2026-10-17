/* global process */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
for (const kind of ['profile', 'repo', 'manifest', 'config']) {
  const expected = JSON.parse(await readFile(join(root, 'schemas', `${kind}.schema.json`), 'utf8'));
  assert.deepEqual(JSON.parse((await run(['schema', kind])).stdout), expected);
}

// Public status and malformed import exercise the real entry point without
// reading or writing the user's private machine store.
const workspace = await mkdtemp(join(tmpdir(), 'cloak package '));
try {
  const hash = `sha256-${createHash('sha256').update('before').digest('hex')}`;
  await mkdir(join(workspace, '.repo-cloak'));
  await writeFile(
    join(workspace, '.repo-cloak', 'manifest.json'),
    JSON.stringify({
      kind: 'manifest',
      schemaVersion: 2,
      tool: { name: 'repo-cloak', version: pkg.version },
      workspaceId: 'package-test',
      source: { repoId: '0123456789abcdef' },
      files: Object.fromEntries(
        ['same.txt', 'changed.txt', 'gone.txt'].map((path) => [
          path,
          { hash, size: 6, binary: false },
        ]),
      ),
      pulls: [],
      sealed: { alg: 'A256GCM', keyId: 'unavailable', nonce: 'unavailable', data: 'unavailable' },
    }),
  );
  await writeFile(join(workspace, 'same.txt'), 'before');
  await writeFile(join(workspace, 'changed.txt'), 'after');
  await writeFile(join(workspace, 'added.txt'), 'added');
  assert.deepEqual(JSON.parse((await run(['status', '--json'], workspace)).stdout), {
    workspaceId: 'package-test',
    added: ['added.txt'],
    modified: ['changed.txt'],
    deleted: ['gone.txt'],
  });
  await writeFile(join(workspace, 'invalid.json'), '{');
  await assert.rejects(
    run(['profile', 'import', 'invalid.json', '--global', '--yes'], workspace),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /^error: /);
      assert.equal(error.stdout, '');
      return true;
    },
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
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
  'README.md',
  'LICENSE',
  'package.json',
  ...['profile', 'repo', 'manifest', 'config'].map((kind) => `schemas/${kind}.schema.json`),
]) {
  assert.ok(files.has(path), `Package is missing ${path}`);
}
assert.ok(
  pack.files
    .filter((file) => file.path.startsWith('dist/ui/'))
    .reduce((sum, file) => sum + file.size, 0) < 50_000,
);
for (const path of files)
  assert.ok(!/^(src|tests|archive|coverage)\//.test(path), `Unexpected package file: ${path}`);
process.stdout.write(`Package checks passed (${pack.files.length} files).\n`);
