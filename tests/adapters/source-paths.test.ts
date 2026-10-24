import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { listSourcePaths } from '../../src/adapters/source-paths.js';
import { runGit } from '../../src/adapters/git.js';
import { validateProfile } from '../../src/core/rules.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cloak inventory '));
  roots.push(root);
  await runGit(root, ['init', '-b', 'main']);
  const globalIgnore = join(root, '.git', 'global-ignore');
  await writeFile(globalIgnore, 'global-private.txt\n');
  await runGit(root, ['config', 'core.excludesFile', globalIgnore]);
  await writeFile(join(root, '.gitignore'), '.env\nignored/\ntracked.txt\n');
  await writeFile(join(root, '.git', 'info', 'exclude'), 'local-private.txt\n');
  await writeFile(join(root, 'tracked.txt'), 'tracked');
  await runGit(root, ['add', '-f', '--', 'tracked.txt', '.gitignore']);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', '.gitignore'), 'generated.txt\n');
  for (const file of [
    '.env',
    'global-private.txt',
    'local-private.txt',
    'new file.txt',
    'src/code.ts',
    'src/generated.txt',
  ])
    await writeFile(join(root, file), 'content');
  return root;
}

it('lists tracked and nonignored untracked files using standard Git ignore sources', async () => {
  const root = await fixture();
  expect(await listSourcePaths(root, [], true)).toEqual([
    '.gitignore',
    'new file.txt',
    'src/.gitignore',
    'src/code.ts',
    'tracked.txt',
  ]);
  expect(await listSourcePaths(root, [], false)).toContain('.env');
  expect(await listSourcePaths(root, [], false)).toContain('src/generated.txt');
});

it('rescans fresh, handles unusual names, and omits deleted paths, metadata and nested repositories', async () => {
  const root = await fixture();
  await rm(join(root, 'tracked.txt'));
  await mkdir(join(root, 'nested'));
  await runGit(join(root, 'nested'), ['init']);
  await writeFile(join(root, 'nested', 'private.ts'), 'nested');
  await mkdir(join(root, '.repo-cloak'));
  await writeFile(join(root, '.repo-cloak', 'manifest.json'), 'private');
  const name = process.platform === 'win32' ? 'space ü.txt' : 'tab\tand\nnewline ü.txt';
  await writeFile(join(root, name), 'content');
  const before = await listSourcePaths(root);
  expect(before).toContain(name);
  expect(before).not.toContain('tracked.txt');
  expect(before.some((path) => path.startsWith('nested/'))).toBe(false);
  expect(before.some((path) => path.startsWith('.repo-cloak/'))).toBe(false);
  await writeFile(join(root, 'fresh.ts'), 'fresh');
  expect(await listSourcePaths(root)).toContain('fresh.ts');
});

it('keeps repo-cloak exclusions and explicit profile includes independent from Git ignores', async () => {
  const root = await fixture();
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'dependency.js'), 'dependency');
  await writeFile(join(root, 'package-lock.json'), '{}');
  const profile = validateProfile({
    kind: 'profile',
    schemaVersion: 1,
    name: 'test',
    rules: [],
    exclude: ['src/**'],
    include: ['package-lock.json'],
  });
  for (const respectGitIgnore of [true, false]) {
    const paths = await listSourcePaths(root, [profile], respectGitIgnore);
    expect(paths).toContain('package-lock.json');
    expect(paths.some((path) => path.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('src/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('.git/'))).toBe(false);
  }
});
