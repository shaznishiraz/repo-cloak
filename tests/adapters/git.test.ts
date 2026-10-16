import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { findRepo, resolveRepo } from '../../src/adapters/git.js';
import { repoId } from '../../src/core/identity.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cloak git '));
  roots.push(root);
  const repo = join(root, 'source ü');
  await mkdir(repo);
  await exec('git', ['init', repo]);
  await exec('git', ['-C', repo, 'config', 'core.hooksPath', join(root, 'no-hooks')]);
  await exec('git', ['-C', repo, 'config', 'commit.gpgSign', 'false']);
  await exec('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'initial',
  ]);
  return { root, repo };
}
describe('repo identity', () => {
  it('hashes a canonical common-directory path deterministically', () => {
    expect(repoId('/repo/.git')).toMatch(/^[a-f0-9]{16}$/);
    expect(repoId('/repo/.git')).toBe(repoId('/repo/.git'));
    expect(repoId('/other/.git')).not.toBe(repoId('/repo/.git'));
  });
  it('resolves nested directories and symlink aliases to one identity', async () => {
    const { root, repo } = await fixture();
    const nested = join(repo, 'nested');
    await mkdir(nested);
    const alias = join(root, 'alias');
    await symlink(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await resolveRepo(nested);
    expect(result.topLevel).toBe(await realpath(repo));
    expect(await resolveRepo(alias)).toEqual(result);
  });
  it('shares identity across linked worktrees, including when called below their root', async () => {
    const { root, repo } = await fixture();
    const linked = join(root, 'linked tree');
    await exec('git', ['-C', repo, 'worktree', 'add', '-b', 'feature', linked]);
    await mkdir(join(linked, 'nested'));
    const a = await resolveRepo(repo);
    const b = await resolveRepo(join(linked, 'nested'));
    expect(b.repoId).toBe(a.repoId);
    expect(b.commonDir).toBe(a.commonDir);
    expect(b.topLevel).toBe(await realpath(linked));
  });
  it('reports paths outside git repos', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cloak no git '));
    roots.push(root);
    await writeFile(join(root, 'file'), 'x');
    await expect(resolveRepo(root)).rejects.toThrow(/git repository/i);
    expect(await findRepo(root)).toBeUndefined();
  });
});

it('selects current working paths and changed commit paths, including spaces', async () => {
  const { repo } = await fixture();
  await writeFile(join(repo, 'a file.ts'), 'first');
  await exec('git', ['-C', repo, 'add', '--', 'a file.ts']);
  await exec('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'file',
  ]);
  const { commitFiles, workingFiles, repoState, worktrees } =
    await import('../../src/adapters/git.js');
  expect(await commitFiles(repo, 'HEAD')).toEqual(['a file.ts']);
  await writeFile(join(repo, 'a file.ts'), 'changed');
  await writeFile(join(repo, 'untracked.ts'), 'new');
  expect(await workingFiles(repo)).toEqual(expect.arrayContaining(['a file.ts', 'untracked.ts']));
  expect((await repoState(repo)).commit).toMatch(/^[a-f0-9]{40}$/);
  expect((await worktrees(repo))[0]?.branch).toBe((await repoState(repo)).branch);
  await expect(commitFiles(repo, '--bad-option')).rejects.toThrow();
});
