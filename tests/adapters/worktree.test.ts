import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { runGit } from '../../src/adapters/git.js';
import { create, readCommit, resolveBase } from '../../src/adapters/worktree.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak worktree ')));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await runGit(source, ['init', '-b', 'main']);
  await runGit(source, ['config', 'core.hooksPath', join(root, 'no-hooks')]);
  await writeFile(join(source, 'file with spaces.bin'), Buffer.from([0, 255, 1, 128]));
  await writeFile(join(source, 'text.txt'), '\uFEFFtext\r\n');
  await runGit(source, ['-c', 'core.autocrlf=false', 'add', '--', '.']);
  await runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-m',
    'base',
  ]);
  return { root, source, base: await resolveBase(source, 'HEAD') };
}
it('reads exact commit bytes and inventories paths without checking out files', async () => {
  const { source, base } = await fixture();
  await writeFile(join(source, 'text.txt'), 'working edit');
  const snapshot = await readCommit(
    source,
    base,
    ['text.txt', 'file with spaces.bin', 'missing'],
    2,
  );
  expect(snapshot.files[0]?.text).toBe('\uFEFFtext\r\n');
  expect(snapshot.files[1]?.bytes).toEqual(Buffer.from([0, 255, 1, 128]));
  expect(snapshot.files[1]?.binary).toBe(true);
  expect(snapshot.files[2]?.bytes).toBeUndefined();
  expect(snapshot.paths.sort()).toEqual(['file with spaces.bin', 'text.txt']);
});
it('cleans its newly created branch when Git refuses the checkout, preserving an existing folder', async () => {
  const { root, source, base } = await fixture();
  const destination = join(root, 'occupied');
  await mkdir(destination);
  await writeFile(join(destination, 'keep.txt'), 'keep');
  await expect(create(source, destination, 'feature/failed', base)).rejects.toThrow();
  expect((await runGit(source, ['branch', '--list', 'feature/failed'])).trim()).toBe('');
  expect(await readFile(join(destination, 'keep.txt'), 'utf8')).toBe('keep');
});
it('disables checkout hooks when creating a worktree', async () => {
  const { root, source, base } = await fixture();
  const hooks = join(root, 'hooks');
  await mkdir(hooks);
  await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\nprintf ran > hook-ran\nexit 99\n');
  await chmod(join(hooks, 'post-checkout'), 0o755);
  await runGit(source, ['config', 'core.hooksPath', hooks]);
  const destination = join(root, 'feature');
  await create(source, destination, 'feature/new', base);
  expect((await runGit(destination, ['branch', '--show-current'])).trim()).toBe('feature/new');
  await expect(readFile(join(destination, 'hook-ran'))).rejects.toThrow();
});

it('refuses symlink and submodule entries before any checkout', async () => {
  const { source, base } = await fixture();
  const blob = (await runGit(source, ['hash-object', '--', 'text.txt'])).trim();
  await runGit(source, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  await runGit(source, ['update-index', '--add', '--cacheinfo', `160000,${base},module`]);
  await runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-m',
    'special entries',
  ]);
  const commit = await resolveBase(source, 'HEAD');
  await expect(readCommit(source, commit, ['link'], 2)).rejects.toThrow('symlink');
  await expect(readCommit(source, commit, ['module'], 2)).rejects.toThrow('submodule');
  await expect(readCommit(source, commit, ['link/file.txt'], 2)).rejects.toThrow(
    'non-directory parent',
  );
});
