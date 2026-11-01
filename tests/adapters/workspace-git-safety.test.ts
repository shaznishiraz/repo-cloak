import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, appendFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '../../src/adapters/git.js';
import { commitWorkspace, prepareWorkspaceGit } from '../../src/adapters/workspace-git.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
const ran = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A workspace an agent has edited, and a payload that leaves a mark if anything runs it. */
async function workspace() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'cloak git safety ')));
  roots.push(parent);
  const root = join(parent, 'ws');
  await mkdir(join(root, '.repo-cloak'), { recursive: true });
  git(root, 'init', '-q', '-b', 'cloak');
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x',
  );
  await writeFile(join(root, 'a.txt'), 'edit\n');
  const mark = join(parent, 'ran');
  const payload = join(parent, 'payload.sh');
  await writeFile(payload, `#!/bin/sh\ntouch "${mark}"\nexit 0\n`);
  await chmod(payload, 0o755);
  return { root, mark, payload };
}
const unix = process.platform === 'win32' ? describe.skip : describe;

unix('a cloak workspace with a planted Git config', () => {
  it('refuses a clean filter before Git can run it', async () => {
    const { root, mark, payload } = await workspace();
    await appendFile(join(root, '.git/config'), `[filter "z"]\n\tclean = "${payload}"\n`);
    await writeFile(join(root, '.git/info/attributes'), '* filter=z\n');
    await expect(prepareWorkspaceGit(root, ['a.txt'])).rejects.toThrow('filter.z.clean');
    await expect(commitWorkspace(root, ['a.txt'])).rejects.toThrow('filter.z.clean');
    await expect(runGit(root, ['status', '--porcelain'])).rejects.toThrow('filter.z.clean');
    expect(await ran(mark)).toBe(false);
  });
  it('refuses fsmonitor and includes', async () => {
    const { root, mark, payload } = await workspace();
    await appendFile(join(root, '.git/config'), `[core]\n\tfsmonitor = "${payload}"\n`);
    await expect(commitWorkspace(root, ['a.txt'])).rejects.toThrow('core.fsmonitor');
    git(root, 'config', '--unset', 'core.fsmonitor');
    await appendFile(join(root, '.git/config'), `[include]\n\tpath = "${payload}.cfg"\n`);
    await expect(commitWorkspace(root, ['a.txt'])).rejects.toThrow('include.path');
    expect(await ran(mark)).toBe(false);
  });
  it('checks even when the .repo-cloak folder was removed', async () => {
    const { root, payload } = await workspace();
    await rm(join(root, '.repo-cloak'), { recursive: true });
    await appendFile(join(root, '.git/config'), `[core]\n\tfsmonitor = "${payload}"\n`);
    await expect(commitWorkspace(root, ['a.txt'])).rejects.toThrow('core.fsmonitor');
  });
  it('refuses a .git file pointing elsewhere', async () => {
    const { root } = await workspace();
    await rm(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git'), 'gitdir: /somewhere/else\n');
    await expect(prepareWorkspaceGit(root, ['a.txt'])).rejects.toThrow('real .git directory');
  });
  it('does not run hooks planted in either hooks folder', async () => {
    const { root, mark, payload } = await workspace();
    for (const folder of ['.git/hooks', '.git/repo-cloak-hooks']) {
      await mkdir(join(root, folder), { recursive: true });
      for (const hook of ['pre-commit', 'commit-msg', 'post-commit'])
        await writeFile(join(root, folder, hook), `#!/bin/sh\n"${payload}"\n`, { mode: 0o755 });
    }
    await commitWorkspace(root, ['a.txt'], 'refresh');
    expect(await ran(mark)).toBe(false);
    expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('refresh');
  });
  it('still commits in an ordinary workspace with a remote and identity', async () => {
    const { root } = await workspace();
    git(root, 'remote', 'add', 'origin', 'https://example.test/x.git');
    git(root, 'config', 'user.name', 'Someone');
    expect(await prepareWorkspaceGit(root, ['a.txt'])).toBe(false);
    await commitWorkspace(root, ['a.txt'], 'refresh');
    expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('refresh');
    expect(await runGit(root, ['status', '--porcelain'])).not.toContain('a.txt');
  });
});
