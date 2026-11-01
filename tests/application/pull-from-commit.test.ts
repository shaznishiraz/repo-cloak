import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { readCommitSource } from '../../src/adapters/worktree.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { createDashboardSync } from '../../src/application/dashboard-sync.js';

vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const identity = [
  '-c',
  'user.email=t@example.com',
  '-c',
  'user.name=t',
  '-c',
  'commit.gpgSign=false',
];

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak commit ')));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = createStore(join(root, 'store'));
  const source = join(root, 'source');
  const destination = join(root, 'cloak');
  await mkdir(source);
  const dashboard = createDashboard(store, source);
  cleanups.push(async () => dashboard.sync.close());
  const services = createSyncServices(source, store);
  const git = (...args: string[]) => services.git.runGit(source, args);
  await git('init', '-b', 'main');
  await writeFile(join(source, 'Acme.ts'), 'class Acme { one() {} }\n');
  await writeFile(join(source, 'Keep.ts'), 'keep\n');
  await git('add', '-A');
  await git(...identity, 'commit', '-qm', 'first');
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  const { repoId } = await dashboard.addRepository({ path: source });
  const profile = await dashboard.saveProfile({
    scope: { kind: 'repo', repoId },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'sample',
      exclude: ['excluded.ts'],
      rules: [
        { id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' },
        { id: 'keys', type: 'secret', detector: 'github-token' },
      ],
    },
  });
  const created = await dashboard.sync.preview({
    intent: 'create',
    repoId,
    worktree: source,
    destination,
    files: ['Acme.ts', 'Keep.ts'],
    profiles: [{ id: profile.id, scope: profile.scope }],
  });
  await dashboard.sync.apply(created.operationId, {});
  const made = await dashboard.sync.wait(created.operationId);
  if (!made.result) throw new Error(`Workspace was not created: ${made.error}`);
  const workspaceId = made.result.workspaceId;
  const commit = async (message: string) => {
    await git('add', '-A');
    await git(...identity, 'commit', '-qm', message);
    return (await git('rev-parse', 'HEAD')).trim();
  };
  const pull = (ref: string) =>
    dashboard.sync.preview({
      intent: 'refresh',
      repoId,
      workspaceId,
      worktree: source,
      fromCommit: ref,
    });
  const apply = async (operationId: string, ack = {}) => {
    await dashboard.sync.apply(operationId, ack);
    return dashboard.sync.wait(operationId);
  };
  const snapshot = async () => {
    const found = await services.store.readSnapshot(destination);
    if (!found) throw new Error('Missing manifest');
    return found;
  };
  return {
    root,
    store,
    source,
    destination,
    dashboard,
    services,
    git,
    repoId,
    workspaceId,
    commit,
    pull,
    apply,
    snapshot,
  };
}

it('takes committed content over a dirty worktree, anonymized the normal way', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'Acme.ts'), 'class Acme { committed() {} }\n');
  const sha = await f.commit('second');
  await writeFile(join(f.source, 'Acme.ts'), 'class Acme { dirtyWorktree() {} }\n');

  const preview = await f.pull(sha);
  expect(preview.writes).toEqual(['Northwind.ts']);
  expect(preview.sourceCommit).toBe(sha);
  expect((await f.apply(preview.operationId)).state).toBe('completed');

  const text = await readFile(join(f.destination, 'Northwind.ts'), 'utf8');
  expect(text).toBe('class Northwind { committed() {} }\n');
  expect(text).not.toContain('dirtyWorktree');
  expect(text).not.toContain('Acme');
  // The worktree edit is left alone.
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toContain('dirtyWorktree');
});

it('reads a file the worktree no longer has, from an older commit', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'Old.ts'), 'class Acme { old() {} }\n');
  const older = await f.commit('adds old');
  await rm(join(f.source, 'Old.ts'));
  await f.commit('removes old');
  const preview = await f.pull(older);
  expect(preview.writes).toEqual(['Old.ts']);
  expect((await f.apply(preview.operationId)).state).toBe('completed');
  expect(await readFile(join(f.destination, 'Old.ts'), 'utf8')).toBe(
    'class Northwind { old() {} }\n',
  );
});

it('records the commit in the sealed manifest and history, never in the plain part', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'Keep.ts'), 'from the commit\n');
  const sha = await f.commit('second');
  const before = await f.snapshot();
  const preview = await f.pull(sha);
  expect((await f.apply(preview.operationId)).state).toBe('completed');

  const after = await f.snapshot();
  expect(after.data.pulls.at(-1)).toMatchObject({ commit: sha, fromCommit: sha, branch: 'main' });
  expect(after.plain.pulls.at(-1)?.selection.commits).toBe(1);
  expect(after.data.origin).toEqual(before.data.origin);
  const raw = await readFile(join(f.destination, '.repo-cloak/manifest.json'), 'utf8');
  expect(raw).not.toContain(sha);

  const { events } = await f.dashboard.sync.audit.list({ limit: 10 });
  const event = events.find((item) => item.op === 'pull');
  expect(event).toMatchObject({ outcome: 'ok', detail: `Pulled from commit ${sha}` });
  expect(event?.files.map((file) => file.path)).toEqual(['Keep.ts']);
});

it('does not mark a normal pull as coming from a commit', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'Keep.ts'), 'worktree\n');
  const preview = await f.dashboard.sync.preview({
    intent: 'refresh',
    repoId: f.repoId,
    workspaceId: f.workspaceId,
    worktree: f.source,
  });
  expect(preview).not.toHaveProperty('sourceCommit');
  expect((await f.apply(preview.operationId)).state).toBe('completed');
  expect((await f.snapshot()).data.pulls.at(-1)).not.toHaveProperty('fromCommit');
  expect(await readFile(join(f.destination, 'Keep.ts'), 'utf8')).toBe('worktree\n');
});

it('applies exclusions and secret redaction to committed blobs', async () => {
  const f = await fixture();
  const token = `ghp_${'a1B2'.repeat(9)}`;
  await writeFile(join(f.source, 'Keep.ts'), `const token = "${token}";\n`);
  await writeFile(join(f.source, 'excluded.ts'), 'profile excludes this\n');
  await writeFile(join(f.source, 'repo-private.ts'), 'repository excludes this\n');
  await writeFile(join(f.source, 'package-lock.json'), '{}\n');
  const sha = await f.commit('sensitive');
  await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['repo-private.ts'] });

  const preview = await f.pull(sha);
  expect(preview.writes).toEqual(['Keep.ts']);
  expect(preview.redactions).toBe(1);
  expect((await f.apply(preview.operationId)).state).toBe('completed');
  const written = await readFile(join(f.destination, 'Keep.ts'), 'utf8');
  expect(written).not.toContain(token);
  for (const name of ['excluded.ts', 'repo-private.ts', 'package-lock.json'])
    await expect(readFile(join(f.destination, name))).rejects.toThrow();
});

it('holds to the preview memory limit that bounds a normal pull', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'Keep.ts'), 'from the commit\n');
  const sha = await f.commit('second');
  const limited = createDashboardSync(f.store, { maxBytes: 1 });
  cleanups.push(async () => limited.close());
  await expect(
    limited.preview({
      intent: 'refresh',
      repoId: f.repoId,
      workspaceId: f.workspaceId,
      worktree: f.source,
      fromCommit: sha,
    }),
  ).rejects.toThrow(/memory limit/);
});

it('deletes a tracked file the commit deleted, only after acknowledgement', async () => {
  const f = await fixture();
  await rm(join(f.source, 'Keep.ts'));
  const sha = await f.commit('deletes');
  // The worktree has it again, and the commit must still win.
  await writeFile(join(f.source, 'Keep.ts'), 'back in the worktree\n');
  const preview = await f.pull(sha);
  expect(preview.deletes).toEqual(['Keep.ts']);
  await expect(f.dashboard.sync.apply(preview.operationId, {})).rejects.toThrow(/deletions/);
  expect((await f.apply(preview.operationId, { deletions: true })).state).toBe('completed');
  await expect(readFile(join(f.destination, 'Keep.ts'))).rejects.toThrow();
  expect(Object.values((await f.snapshot()).data.files).map((file) => file.path)).toEqual([
    'Acme.ts',
  ]);
});

it('reports a conflict when the commit deleted a file edited in the cloak', async () => {
  const f = await fixture();
  await writeFile(join(f.destination, 'Keep.ts'), 'edited in the cloak\n');
  await rm(join(f.source, 'Keep.ts'));
  const sha = await f.commit('deletes');
  const preview = await f.pull(sha);
  expect(preview.canApply).toBe(false);
  expect(preview.conflicts.join()).toContain('Keep.ts');
  await expect(f.dashboard.sync.apply(preview.operationId, {})).rejects.toThrow(/conflict/i);
  expect(await readFile(join(f.destination, 'Keep.ts'), 'utf8')).toBe('edited in the cloak\n');
});

it('skips a committed symlink, even one pointing at a real file, with a warning', async () => {
  const f = await fixture();
  await symlink(join(f.root, 'outside.ts'), join(f.source, 'external.ts'));
  await symlink('Acme.ts', join(f.source, 'internal.ts'));
  const sha = await f.commit('links');
  const preview = await f.pull(sha);
  expect(preview.writes).toEqual([]);
  expect(preview.warnings).toEqual(
    expect.arrayContaining(['external.ts: skipped symlink', 'internal.ts: skipped symlink']),
  );
  expect((await f.apply(preview.operationId)).state).toBe('completed');
  await expect(readFile(join(f.destination, 'internal.ts'))).rejects.toThrow();
});

it('skips a committed submodule with a warning', async () => {
  const f = await fixture();
  const head = (await f.git('rev-parse', 'HEAD')).trim();
  await f.git('update-index', '--add', '--cacheinfo', `160000,${head},vendored`);
  await f.git(...identity, 'commit', '-qm', 'adds a submodule');
  const sha = (await f.git('rev-parse', 'HEAD')).trim();
  const preview = await f.pull(sha);
  expect(preview.writes).toEqual([]);
  expect(preview.warnings).toContain('vendored: skipped submodule');
});

it('treats a path whose parent became a file as gone, and refuses to replace the folder', async () => {
  const f = await fixture();
  await mkdir(join(f.source, 'dir'));
  await writeFile(join(f.source, 'dir/inner.ts'), 'inner\n');
  await f.commit('adds dir');
  const added = await f.dashboard.sync.preview({
    intent: 'refresh',
    repoId: f.repoId,
    workspaceId: f.workspaceId,
    worktree: f.source,
    files: ['dir/inner.ts'],
  });
  expect((await f.apply(added.operationId)).state).toBe('completed');
  await rm(join(f.source, 'dir'), { recursive: true });
  await writeFile(join(f.source, 'dir'), 'now a file\n');
  const sha = await f.commit('replaces dir');
  const { files } = await readCommitSource(f.source, sha, ['dir/inner.ts'], 4);
  expect(files).toEqual([{ path: 'dir/inner.ts', binary: false, executable: false }]);
  // The cloak still has the folder, and a normal pull refuses this in the same way.
  await expect(f.pull(sha)).rejects.toThrow(/not a regular file/);
  expect(await readFile(join(f.destination, 'dir/inner.ts'), 'utf8')).toBe('inner\n');
});

it('copies a committed binary unchanged and keeps the executable bit', async () => {
  const f = await fixture();
  const binary = Buffer.from([0x41, 0x63, 0x6d, 0x65, 0, 1, 2, 3]);
  await writeFile(join(f.source, 'image.bin'), binary);
  await writeFile(join(f.source, 'run.sh'), '#!/bin/sh\necho Acme\n', { mode: 0o755 });
  const sha = await f.commit('binary');
  await writeFile(join(f.source, 'image.bin'), 'dirty');
  const preview = await f.pull(sha);
  expect(preview.warnings).toContain('image.bin: binary file copied unchanged');
  expect((await f.apply(preview.operationId)).state).toBe('completed');
  expect(await readFile(join(f.destination, 'image.bin'))).toEqual(binary);
  expect(await readFile(join(f.destination, 'run.sh'), 'utf8')).toContain('echo Northwind');
  const entry = Object.values((await f.snapshot()).data.files).find(
    (file) => file.path === 'run.sh',
  );
  expect(entry?.executable).toBe(true);
});

it('rejects an unknown sha, an unknown ref and something that is not a commit', async () => {
  const f = await fixture();
  const tree = (await f.git('rev-parse', 'HEAD^{tree}')).trim();
  for (const ref of ['0123456789012345678901234567890123456789', 'no-such-branch', tree])
    await expect(f.pull(ref)).rejects.toThrow(`Commit not found: ${ref}`);
  await expect(f.pull('--all')).rejects.toThrow(/Commit not found/);
});

it('resolves a branch once and goes stale when it moves before apply', async () => {
  const f = await fixture();
  await f.git('branch', 'feature');
  await f.git('worktree', 'add', join(f.root, 'feature-tree'), 'feature');
  const feature = join(f.root, 'feature-tree');
  await writeFile(join(feature, 'Keep.ts'), 'feature one\n');
  await f.services.git.runGit(feature, ['add', '-A']);
  await f.services.git.runGit(feature, [...identity, 'commit', '-qm', 'one']);
  const preview = await f.pull('feature');
  expect(preview.sourceCommit).toBe((await f.git('rev-parse', 'feature')).trim());
  await writeFile(join(feature, 'Keep.ts'), 'feature two\n');
  await f.services.git.runGit(feature, ['add', '-A']);
  await f.services.git.runGit(feature, [...identity, 'commit', '-qm', 'two']);
  const done = await f.apply(preview.operationId);
  expect(done.state).toBe('failed');
  expect(done.code).toBe('stale');
  expect(await readFile(join(f.destination, 'Keep.ts'), 'utf8')).toBe('keep\n');
});

it('stays valid when only unrelated worktree files change before apply', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'Keep.ts'), 'committed\n');
  const sha = await f.commit('second');
  const preview = await f.pull(sha);
  await writeFile(join(f.source, 'Keep.ts'), 'dirty after review\n');
  await writeFile(join(f.source, 'build-output.txt'), 'generated\n');
  expect((await f.apply(preview.operationId)).state).toBe('completed');
  expect(await readFile(join(f.destination, 'Keep.ts'), 'utf8')).toBe('committed\n');
});

it('goes stale when the workspace changes between preview and apply', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'Keep.ts'), 'committed\n');
  const sha = await f.commit('second');
  const preview = await f.pull(sha);
  await writeFile(join(f.destination, 'Keep.ts'), 'edited after review\n');
  expect((await f.apply(preview.operationId)).state).toBe('failed');
  expect(await readFile(join(f.destination, 'Keep.ts'), 'utf8')).toBe('edited after review\n');
});

it('refuses a commit pull while profiles have changed', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'Keep.ts'), 'committed\n');
  const sha = await f.commit('second');
  const profile = (await f.dashboard.profiles(f.repoId))[0];
  if (!profile) throw new Error('Missing profile');
  await f.dashboard.saveProfile({
    ...profile,
    profile: { ...profile.profile, description: 'edited' },
  });
  await expect(f.pull(sha)).rejects.toThrow(/Profiles changed/);
});

it('blocks a push that would overwrite newer source with an edit based on an old commit', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'Keep.ts'), 'older\n');
  const older = await f.commit('older');
  await writeFile(join(f.source, 'Keep.ts'), 'newer\n');
  await f.commit('newer');
  const preview = await f.pull(older);
  expect((await f.apply(preview.operationId)).state).toBe('completed');
  await writeFile(join(f.destination, 'Keep.ts'), 'older, edited\n');
  const push = await f.dashboard.sync.preview({
    intent: 'restore',
    repoId: f.repoId,
    workspaceId: f.workspaceId,
    worktree: f.source,
  });
  expect(push.canApply).toBe(false);
  expect(push.conflicts.join()).toContain('Keep.ts');
  expect(await readFile(join(f.source, 'Keep.ts'), 'utf8')).toBe('newer\n');
});

it('refuses a blob over the size limit before reading it', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'big.txt'), 'more than ten bytes of text\n');
  const sha = await f.commit('big');
  await expect(readCommitSource(f.source, sha, ['big.txt'], 4, 10)).rejects.toThrow(
    /big\.txt.*limit/,
  );
});
