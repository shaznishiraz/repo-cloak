import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { createDashboardServer } from '../../src/adapters/server.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import type {
  DiffLine,
  OperationState,
  PushApply,
  PushBackup,
  PushReview,
  PushTarget,
} from '../../src/web/api/contracts.js';

// Each test drives real Git through several previews.
vi.setConfig({ testTimeout: 60_000 });
const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const secret = `ghp_${'a1b2c3'.repeat(6)}`;

async function fixture(initGit = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak push ')));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, 'source');
  const workspace = join(root, 'workspace');
  await mkdir(source);
  const git = (cwd: string, ...args: string[]) =>
    exec(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.test',
        '-c',
        'commit.gpgSign=false',
        '-c',
        `core.hooksPath=${join(root, 'no-hooks')}`,
        ...args,
      ],
      { cwd },
    ).then(({ stdout }) => stdout.trim());
  await git(source, 'init', '-b', 'main');
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1} of Acme`);
  await writeFile(join(source, 'Acme.ts'), `${lines.join('\n')}\n`);
  await writeFile(join(source, 'other.ts'), 'class AcmeOther {}\n');
  await writeFile(join(source, 'gone.ts'), 'to be removed\n');
  await writeFile(join(source, 'keys.ts'), `const key = "${secret}";\nconst name = "Acme";\n`);
  await git(source, 'add', '-A');
  await git(source, 'commit', '-m', 'initial');
  const store = createStore(join(root, 'store'));
  const services = createSyncServices(source, store);
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit });
  const dashboard = createDashboard(store, source);
  const { repoId = '' } = await dashboard.context();
  const profile = await dashboard.saveProfile({
    scope: { kind: 'global' },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'names',
      rules: [
        { id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' },
        { id: 'key', type: 'secret', detector: 'github-token' },
      ],
    },
  });
  const created = await dashboard.sync.preview({
    intent: 'create',
    repoId,
    worktree: source,
    destination: workspace,
    profiles: [{ id: profile.id, scope: { kind: 'global' } }],
    files: ['Acme.ts', 'other.ts', 'gone.ts', 'keys.ts'],
  });
  await dashboard.sync.apply(created.operationId, {});
  const done = await dashboard.sync.wait(created.operationId);
  if (done.state !== 'completed') throw new Error(done.error ?? 'create failed');
  const workspaceId = done.result?.workspaceId ?? '';
  const server = createDashboardServer(dashboard, 'test-token', resolve('src/web'));
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  cleanups.push(
    () =>
      new Promise<void>((closed, fail) => {
        server.close((error) => (error ? fail(error) : closed()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}/api/v2/push/${repoId}/${encodeURIComponent(workspaceId)}`;
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const reviewOf = async (target: PushTarget = { kind: 'origin' }) => {
    const response = await post('/review', { target });
    const value = (await response.json()) as PushReview & { error?: string };
    if (!response.ok) throw new Error(value.error);
    return value;
  };
  const diffOf = async (path: string) => {
    const response = await fetch(`${base}/diff?path=${encodeURIComponent(path)}`, { headers });
    return ((await response.json()) as { lines: DiffLine[] }).lines;
  };
  const apply = async (
    operationId: string | null,
    options: Partial<Omit<PushApply, 'operationId'>> = {},
  ) => {
    const response = await post('/apply', {
      operationId,
      mode: 'write',
      repull: false,
      includeGroupMembers: false,
      mergeMode: 'merge',
      ...options,
    });
    const value = (await response.json()) as OperationState & { error?: string };
    if (!response.ok) throw new Error(value.error);
    return dashboard.sync.wait(value.operationId);
  };
  const backups = async () => {
    const response = await fetch(`${base}/backups`, { headers });
    return ((await response.json()) as { backups: PushBackup[] }).backups;
  };
  const edit = (name: string, text: string, root_ = workspace) =>
    writeFile(join(root_, name), text);
  const read = (name: string, root_ = source) => readFile(join(root_, name), 'utf8');
  return {
    root,
    source,
    workspace,
    git,
    dashboard,
    repoId,
    workspaceId,
    base,
    headers,
    post,
    reviewOf,
    diffOf,
    apply,
    backups,
    edit,
    read,
    lines,
  };
}
const editedLines = (lines: string[], at: number, text: string) =>
  `${lines.map((line, index) => (index === at ? text : line)).join('\n')}\n`.replaceAll(
    'Acme',
    'Northwind',
  );

it('lists file changes with flags and passes the guard checks', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 10, 'edited line'));
  await f.edit('NorthwindExportJob.ts', 'export class NorthwindExportJob {}\n');
  await rm(join(f.workspace, 'gone.ts'));
  const review = await f.reviewOf();
  expect(review.canApply).toBe(true);
  expect(review.operationId).toEqual(expect.any(String));
  const byPath = new Map(review.files.map((file) => [file.path, file]));
  expect(byPath.get('Northwind.ts')).toMatchObject({
    restoredPath: 'Acme.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    flags: ['clean'],
  });
  expect(byPath.get('NorthwindExportJob.ts')).toMatchObject({
    restoredPath: 'AcmeExportJob.ts',
    status: 'added',
    flags: expect.arrayContaining(['new-derived-name']),
  });
  expect(byPath.get('gone.ts')?.status).toBe('deleted');
  expect(review.derivedNames).toContainEqual({
    cloaked: 'NorthwindExportJob',
    restored: 'AcmeExportJob',
  });
  const checks = new Map(review.checks.map((check) => [check.id, check]));
  expect(checks.get('restores')).toMatchObject({ state: 'ok' });
  expect(checks.get('no-leak')).toMatchObject({ state: 'ok' });
  expect(checks.get('merges')).toMatchObject({ state: 'ok' });
  expect(checks.get('manifest')).toMatchObject({ state: 'ok' });
  expect(checks.get('target')?.title).toBe('target is clean');
  // Reviewing writes nothing.
  expect(await f.read('Acme.ts')).toContain('line 11 of Acme');
});

it('shows the cloak and the restored line side by side, without real secrets', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 10, 'const client = "Northwind client";'));
  const lines = await f.diffOf('Northwind.ts');
  expect(lines.find((line) => line.kind === 'add')).toEqual({
    kind: 'add',
    line: 11,
    cloaked: 'const client = "Northwind client";',
    restored: 'const client = "Acme client";',
  });
  expect(lines.find((line) => line.kind === 'remove')).toMatchObject({
    line: 11,
    cloaked: 'line 11 of Northwind',
    restored: 'line 11 of Acme',
  });
  // Three lines of context either side, not the whole file.
  expect(lines).toHaveLength(8);

  const keys = await readFile(join(f.workspace, 'keys.ts'), 'utf8');
  await f.edit('keys.ts', keys.replace('name = "Northwind"', 'name = "Northwind Ltd"'));
  const masked = await f.diffOf('keys.ts');
  expect(JSON.stringify(masked)).not.toContain(secret);
  expect(masked.find((line) => line.kind === 'add')?.restored).toBe('const name = "Acme Ltd";');
  expect(masked.map((line) => line.restored)).toContain('const key = "[secret]";');

  const refused = await fetch(`${f.base}/diff?path=${encodeURIComponent('other.ts')}`, {
    headers: f.headers,
  });
  expect(refused.status).toBe(404);
  const escaped = await fetch(`${f.base}/diff?path=${encodeURIComponent('../secret')}`, {
    headers: f.headers,
  });
  expect(escaped.status).toBe(400);
});

it('builds the diff from the source when the workspace has no Git history', async () => {
  const f = await fixture(false);
  await f.edit('Northwind.ts', editedLines(f.lines, 2, 'changed'));
  const lines = await f.diffOf('Northwind.ts');
  expect(lines.filter((line) => line.kind !== 'context').map((line) => line.line)).toEqual([3, 3]);
  expect((await f.reviewOf()).files[0]).toMatchObject({ additions: 1, deletions: 1 });
});

it('auto-merges a moved source when the edits do not overlap', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 20, 'cloak edit of Northwind'));
  const upstream = f.lines.map((line, index) => (index === 2 ? 'upstream edit of Acme' : line));
  await writeFile(join(f.source, 'Acme.ts'), `${upstream.join('\n')}\n`);
  await f.git(f.source, 'commit', '-am', 'upstream');
  const head = (await f.git(f.source, 'rev-parse', '--short', 'HEAD')).trim();
  const review = await f.reviewOf();
  expect(review.files[0]?.flags).toEqual(expect.arrayContaining(['source-moved', 'auto-merge']));
  const note = review.checks.find((check) => check.id === 'merge:Northwind.ts');
  expect(note).toMatchObject({ state: 'info' });
  expect(note?.detail).toContain(head);
  expect(note?.detail).toContain('line 3');
  expect(note?.detail).toContain('line 21');
  expect(review.checks.find((check) => check.id === 'merges')?.state).toBe('info');
  expect(review.checks.find((check) => check.id === 'target')?.detail).toContain(
    '1 new upstream commit',
  );
  const done = await f.apply(review.operationId);
  expect(done.state).toBe('completed');
  const merged = await f.read('Acme.ts');
  expect(merged).toContain('upstream edit of Acme');
  expect(merged).toContain('cloak edit of Acme');
  expect(merged).not.toContain('Northwind');
});

it('blocks overlapping edits unless overwrite is chosen, and overwrite is reversible', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 5, 'cloak side'));
  const upstream = `${f.lines.map((line, index) => (index === 5 ? 'upstream side' : line)).join('\n')}\n`;
  await writeFile(join(f.source, 'Acme.ts'), upstream);
  const review = await f.reviewOf();
  expect(review.files[0]?.flags).toEqual(expect.arrayContaining(['source-moved', 'conflict']));
  expect(review.checks.find((check) => check.id === 'merges')?.state).toBe('blocked');
  await expect(f.apply(review.operationId)).rejects.toThrow(/overlap upstream/);
  expect(await f.read('Acme.ts')).toBe(upstream);
  // A refused apply keeps the review alive for a different choice.
  const done = await f.apply(review.operationId, { mergeMode: 'overwrite' });
  expect(done.state).toBe('completed');
  expect(await f.read('Acme.ts')).toContain('cloak side');
  const [backup] = await f.backups();
  expect(backup?.files).toBe(1);
  const undone = await f.post(`/backups/${backup?.id}/undo`);
  expect(await undone.json()).toEqual({ restored: 1 });
  expect(await f.read('Acme.ts')).toBe(upstream);
});

it('refuses a cloaked name that cannot restore and a damaged placeholder', async () => {
  const f = await fixture();
  await f.edit('keys.ts', 'const key = "REDACTED_NOT_A_REAL_ONE";\n');
  const review = await f.reviewOf();
  expect(review.canApply).toBe(false);
  expect(review.operationId).toBeNull();
  const restores = review.checks.find((check) => check.id === 'restores');
  expect(restores?.state).toBe('blocked');
  expect(restores?.detail).toContain('keys.ts');
  expect(await f.read('keys.ts')).toContain(secret);
});

it('holds back new files that exclusions keep out of the source', async () => {
  const f = await fixture();
  await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['*.secret'] });
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.edit('notes.secret', 'private');
  const review = await f.reviewOf();
  expect(review.files.map((file) => file.path)).toEqual(['Northwind.ts']);
  const manifest = review.checks.find((check) => check.id === 'manifest');
  expect(manifest?.state).toBe('warning');
  expect(manifest?.detail).toContain('notes.secret');
  await f.apply(review.operationId);
  await expect(f.read('notes.secret')).rejects.toThrow();
});

it('writes only, stages, or commits with the message restored', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'one'));
  await f.apply((await f.reviewOf()).operationId);
  expect(await f.git(f.source, 'diff', '--cached', '--name-only')).toBe('');
  expect(await f.git(f.source, 'diff', '--name-only')).toBe('Acme.ts');

  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'two'));
  await f.apply((await f.reviewOf()).operationId, { mode: 'stage' });
  expect(await f.git(f.source, 'diff', '--cached', '--name-only')).toBe('Acme.ts');

  await writeFile(join(f.source, 'unrelated.txt'), 'staged by the user');
  await f.git(f.source, 'add', 'unrelated.txt');
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'three'));
  const done = await f.apply((await f.reviewOf()).operationId, {
    mode: 'commit',
    commitMessage: 'Add NorthwindExportJob for Northwind',
  });
  expect(done.result?.warnings.join()).toContain('Committed');
  expect(await f.git(f.source, 'log', '-1', '--format=%s')).toBe('Add AcmeExportJob for Acme');
  expect(await f.git(f.source, 'show', '--name-only', '--format=', 'HEAD')).toBe('Acme.ts');
  // Only this push is in the commit; what the user had staged stays staged.
  expect(await f.git(f.source, 'diff', '--cached', '--name-only')).toBe('unrelated.txt');
});

it('rejects a commit without a message, or with a secret placeholder in it', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'one'));
  const review = await f.reviewOf();
  await expect(f.apply(review.operationId, { mode: 'commit' })).rejects.toThrow(/commit message/i);
  const keys = await readFile(join(f.workspace, 'keys.ts'), 'utf8');
  const placeholder = /REDACTED_[A-Za-z0-9_-]*/.exec(keys)?.[0] ?? '';
  expect(placeholder).not.toBe('');
  await expect(
    f.apply(review.operationId, { mode: 'commit', commitMessage: `use ${placeholder}` }),
  ).rejects.toThrow(/secret/);
  expect((await f.apply(review.operationId, {})).state).toBe('completed');
});

it('reports a failed commit as a warning, with the files still pushed', async () => {
  const f = await fixture();
  const hooks = join(f.root, 'hooks');
  await mkdir(hooks);
  await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho "rejected by hook" >&2\nexit 1\n');
  await chmod(join(hooks, 'pre-commit'), 0o755);
  await f.git(f.source, 'config', 'core.hooksPath', hooks);
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'one'));
  const done = await f.apply((await f.reviewOf()).operationId, {
    mode: 'commit',
    commitMessage: 'message',
  });
  expect(done.state).toBe('completed');
  expect(done.result?.warnings.join()).toContain('committing failed');
  expect(await f.read('Acme.ts')).toContain('one');
});

it('re-pulls after a push so the cloak carries merged upstream lines', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 20, 'cloak edit'));
  const upstream = f.lines.map((line, index) => (index === 2 ? 'upstream of Acme' : line));
  await writeFile(join(f.source, 'Acme.ts'), `${upstream.join('\n')}\n`);
  const done = await f.apply((await f.reviewOf()).operationId, { repull: true });
  expect(done.state).toBe('completed');
  expect(done.result?.warnings.join()).not.toContain('re-pull failed');
  const cloak = await readFile(join(f.workspace, 'Northwind.ts'), 'utf8');
  expect(cloak).toContain('upstream of Northwind');
  expect(cloak).toContain('cloak edit');
  expect((await f.reviewOf()).files).toEqual([]);
});

it('keeps a backup, lists it for 7 days, and undoes the push and its baseline', async () => {
  const f = await fixture();
  const before = await f.read('Acme.ts');
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.edit('Northwind2.ts', 'new file\n');
  await rm(join(f.workspace, 'gone.ts'));
  const review = await f.reviewOf();
  expect((await f.apply(review.operationId)).state).toBe('completed');
  await expect(f.read('gone.ts')).rejects.toThrow();
  const backups = await f.backups();
  expect(backups).toHaveLength(1);
  const backup = backups[0];
  expect(backup?.files).toBe(3);
  const days =
    (Date.parse(backup?.expiresAt ?? '') - Date.parse(backup?.createdAt ?? '')) / 86400000;
  expect(days).toBe(7);
  expect((await f.reviewOf()).files).toEqual([]);

  const undone = await f.post(`/backups/${backup?.id}/undo`);
  expect(undone.status).toBe(200);
  expect(await undone.json()).toEqual({ restored: 3 });
  expect(await f.read('Acme.ts')).toBe(before);
  expect(await f.read('gone.ts')).toBe('to be removed\n');
  await expect(f.read('Acme2.ts')).rejects.toThrow();
  // The edits are pending again, so nothing was lost.
  expect((await f.reviewOf()).files.map((file) => file.path).sort()).toEqual([
    'Northwind.ts',
    'Northwind2.ts',
    'gone.ts',
  ]);
  expect(await f.backups()).toEqual([]);
  const again = await f.post(`/backups/${backup?.id}/undo`);
  expect(again.status).toBe(404);
  const events = (await f.dashboard.sync.audit.list()).events;
  expect(events.some((event) => event.detail?.includes('Undid'))).toBe(true);
});

it('stores backups in the source Git directory, not the cloak', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.apply((await f.reviewOf()).operationId);
  const inCloak = await exec('grep', ['-r', '-l', 'line 2 of Acme', f.workspace]).catch(
    () => undefined,
  );
  expect(inCloak).toBeUndefined();
  const inGit = await exec('grep', ['-r', '-l', 'line 2 of Acme', join(f.source, '.git')]);
  expect(inGit.stdout).toContain('repo-cloak-backups');
});

it('refuses to undo over newer work', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.apply((await f.reviewOf()).operationId);
  const [backup] = await f.backups();
  await writeFile(join(f.source, 'Acme.ts'), 'someone kept working');
  const refused = await f.post(`/backups/${backup?.id}/undo`);
  expect(refused.status).toBe(409);
  expect(await f.read('Acme.ts')).toBe('someone kept working');
  expect(await f.backups()).toHaveLength(1);
});

it('removes backups once they expire', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.apply((await f.reviewOf()).operationId);
  const [backup] = await f.backups();
  const later = Date.now() + 8 * 86400000;
  const realNow = Date.now;
  Date.now = () => later;
  try {
    expect(await f.backups()).toEqual([]);
  } finally {
    Date.now = realNow;
  }
  expect((await f.post(`/backups/${backup?.id}/undo`)).status).toBe(404);
});

it('targets main, another worktree, a new worktree, and a read-only dry run', async () => {
  const f = await fixture();
  const other = join(f.root, 'other');
  await f.git(f.source, 'worktree', 'add', '-b', 'other', other);
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'target edit'));

  const dry = await f.reviewOf({ kind: 'dry-run' });
  expect(dry.operationId).toBeNull();
  expect(dry.canApply).toBe(false);
  expect(dry.files).toHaveLength(1);

  const fresh = await f.reviewOf({ kind: 'new-worktree', branch: 'feature/new' });
  expect(fresh.canApply).toBe(true);
  expect(fresh.checks.find((check) => check.id === 'target')?.title).toContain('new worktree');

  const review = await f.reviewOf({ kind: 'worktree', path: other });
  expect(review.canApply).toBe(true);
  await f.apply(review.operationId);
  expect(await f.read('Acme.ts', other)).toContain('target edit');
  expect(await f.read('Acme.ts')).not.toContain('target edit');

  const outsider = await f.post('/review', { target: { kind: 'worktree', path: f.root } });
  expect(outsider.status).toBe(400);
});

it('pushes a new worktree from main without a backup', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  const review = await f.reviewOf({ kind: 'new-worktree', branch: 'from-main' });
  const done = await f.apply(review.operationId);
  expect(done.state).toBe('completed');
  expect(await f.git(f.source, 'branch', '--list', 'from-main')).toContain('from-main');
  expect(await f.backups()).toEqual([]);
});

it('includes group members only when they are safe to push unreviewed', async () => {
  const f = await fixture();
  const secondSource = join(f.root, 'second');
  const secondCloak = join(f.root, 'second-cloak');
  await mkdir(secondSource);
  await f.git(secondSource, 'init', '-b', 'main');
  await writeFile(join(secondSource, 'Acme.web'), 'web of Acme\n');
  await f.git(secondSource, 'add', '-A');
  await f.git(secondSource, 'commit', '-m', 'initial');
  const { dashboard } = f;
  const secondRepo = await dashboard.addRepository({ path: secondSource });
  const [profile] = await dashboard.profiles();
  const created = await dashboard.sync.preview({
    intent: 'create',
    repoId: secondRepo.repoId,
    worktree: secondSource,
    destination: secondCloak,
    profiles: [{ id: profile?.id ?? '', scope: { kind: 'global' } }],
    files: ['Acme.web'],
  });
  await dashboard.sync.apply(created.operationId, {});
  const done = await dashboard.sync.wait(created.operationId);
  const secondId = done.result?.workspaceId ?? '';
  await dashboard.groups.save({
    name: 'claims',
    members: [
      { repoId: f.repoId, workspaceId: f.workspaceId, worktree: f.source },
      { repoId: secondRepo.repoId, workspaceId: secondId, worktree: secondSource },
    ],
  });
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.edit('Northwind.web', 'member edit of Northwind\n', secondCloak);

  // Left out unless it is asked for.
  await f.apply((await f.reviewOf()).operationId);
  expect(await f.read('Acme.web', secondSource)).toBe('web of Acme\n');

  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit again'));
  const pushed = await f.apply((await f.reviewOf()).operationId, {
    includeGroupMembers: true,
    mode: 'commit',
    commitMessage: 'Sync Northwind',
  });
  expect(pushed.result?.warnings.join()).toContain('second-cloak: 1 files pushed');
  expect(await f.read('Acme.web', secondSource)).toBe('member edit of Acme\n');
  expect(await f.git(secondSource, 'log', '-1', '--format=%s')).toBe('Sync Acme');

  // A member whose source moved waits for its own review.
  await f.edit('Northwind.web', 'second edit\n', secondCloak);
  await writeFile(join(secondSource, 'Acme.web'), 'moved upstream\n');
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'third'));
  const held = await f.apply((await f.reviewOf()).operationId, { includeGroupMembers: true });
  expect(held.state).toBe('completed');
  expect(held.result?.warnings.join()).toContain('second-cloak: not pushed');
  expect(await f.read('Acme.web', secondSource)).toBe('moved upstream\n');
});

it('invalidates the review when the source changes, and replaces older reviews', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  const first = await f.reviewOf();
  const second = await f.reviewOf();
  expect(second.operationId).not.toBe(first.operationId);
  await expect(f.apply(first.operationId)).rejects.toThrow(/review the push again/);
  await writeFile(join(f.source, 'other.ts'), 'moved after review\n');
  const stale = await f.apply(second.operationId);
  expect(stale.state).toBe('failed');
  expect(stale.code).toBe('stale');
  expect(await f.read('Acme.ts')).not.toContain('edit');
  expect(await f.backups()).toEqual([]);
});

it('validates every body, query and identifier', async () => {
  const f = await fixture();
  const invalid = [
    await f.post('/review', {}),
    await f.post('/review', { target: { kind: 'nowhere' } }),
    await f.post('/review', { target: { kind: 'origin', extra: true } }),
    await f.post('/review', { target: { kind: 'new-worktree', branch: '' } }),
    await f.post('/apply', { operationId: 'not-a-uuid' }),
    await f.post('/apply', {
      operationId: crypto.randomUUID(),
      mode: 'rm -rf',
      repull: false,
      includeGroupMembers: false,
      mergeMode: 'merge',
    }),
    await f.post('/backups/not-a-uuid/undo'),
    await fetch(`${f.base}/diff`, { headers: f.headers }),
    await fetch(`${f.base.replace(f.repoId, 'nothex')}/backups`, { headers: f.headers }),
  ];
  for (const response of invalid) expect(response.status).toBe(400);
  const unknown = await f.post('/apply', {
    operationId: crypto.randomUUID(),
    mode: 'write',
    repull: false,
    includeGroupMembers: false,
    mergeMode: 'merge',
  });
  expect(unknown.status).toBe(404);
  const anonymous = await fetch(`${f.base}/backups`);
  expect(anonymous.status).toBe(401);
});
