import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { commitPaths } from '../../src/adapters/git.js';
import { createGroupStore } from '../../src/adapters/groups.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { createDashboardGroups } from '../../src/application/dashboard-groups.js';
import { createDashboardSync } from '../../src/application/dashboard-sync.js';

vi.setConfig({ testTimeout: 40_000 });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak bulk ')));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = createStore(join(root, 'store'));
  const dashboard = createDashboard(store, root);
  cleanups.push(async () => dashboard.sync.close());
  const services = createSyncServices(root, store);
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  const members = [];
  for (const name of ['Backend', 'Frontend']) {
    const source = join(root, name);
    const destination = join(root, `${name}-cloak`);
    await mkdir(source);
    const git = (...args: string[]) => services.git.runGit(source, args);
    await git('init', '-b', 'main');
    await git('config', 'user.email', 't@example.com');
    await git('config', 'user.name', 't');
    await git('config', 'commit.gpgSign', 'false');
    await writeFile(join(source, `${name}.ts`), `class ${name} {}\n`);
    await git('add', '-A');
    await git('commit', '-qm', 'initial');
    const { repoId } = await dashboard.addRepository({ path: source });
    const profile = await dashboard.saveProfile({
      scope: { kind: 'repo', repoId },
      profile: {
        kind: 'profile',
        schemaVersion: 1,
        name,
        rules: [{ id: 'name', type: 'literal', match: name, replace: `Safe${name}` }],
      },
    });
    const preview = await dashboard.sync.preview({
      intent: 'create',
      repoId,
      worktree: source,
      destination,
      files: [`${name}.ts`],
      profiles: [{ id: profile.id, scope: profile.scope }],
    });
    await dashboard.sync.apply(preview.operationId, {});
    const result = await dashboard.sync.wait(preview.operationId);
    if (!result.result) throw new Error(`Workspace was not created: ${result.error}`);
    members.push({
      repoId,
      workspaceId: result.result.workspaceId,
      worktree: source,
      destination,
      name,
      git,
      cloaked: join(destination, `Safe${name}.ts`),
      original: join(source, `${name}.ts`),
    });
  }
  const [backend, frontend] = members;
  if (!backend || !frontend) throw new Error('Expected two members');
  const input = {
    name: 'Storefront',
    members: members.map(({ repoId, workspaceId, worktree }) => ({
      repoId,
      workspaceId,
      worktree,
    })),
  };
  const editAll = async () => {
    await writeFile(backend.cloaked, 'class SafeBackend { edited() {} }\n');
    await writeFile(frontend.cloaked, 'class SafeFrontend { edited() {} }\n');
  };
  return { root, store, dashboard, services, backend, frontend, input, editAll };
}

/** A second dashboard process: same store, its own operation queue. */
function secondProcess(store: ReturnType<typeof createStore>) {
  const sync = createDashboardSync(store);
  cleanups.push(async () => sync.close());
  return { sync, groups: createDashboardGroups(store, sync) };
}

/** A dashboard whose named member blocks on the gate, or fails, inside its own write. */
function instrumented(f: Awaited<ReturnType<typeof fixture>>) {
  const applied: string[] = [];
  const control = {
    failing: new Set<string>(),
    gate: Promise.resolve() as Promise<void>,
    open: (() => undefined) as () => void,
    entered: Promise.resolve() as Promise<void>,
  };
  let entered: () => void = () => undefined;
  const hold = () => {
    control.gate = new Promise<void>((resolve) => {
      control.open = resolve;
    });
    control.entered = new Promise<void>((resolve) => {
      entered = resolve;
    });
  };
  const groups = createDashboardGroups(f.store, {
    ...f.dashboard.sync,
    async prepareOperation(value) {
      const operation = await f.dashboard.sync.prepareOperation(value);
      const { repoId } = value as { repoId: string };
      return {
        ...operation,
        async apply() {
          applied.push(repoId);
          entered();
          await control.gate;
          if (control.failing.has(repoId)) throw new Error('Simulated writer failure');
          return operation.apply();
        },
      };
    },
  });
  return { groups, applied, control, hold };
}

/* ---------- Lock ---------- */
it('holds the group lock until the run settles, not just until it is scheduled', async () => {
  const f = await fixture();
  const { groups, control, hold } = instrumented(f);
  const group = await groups.save(f.input);
  await f.editAll();
  hold();
  const preview = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  await groups.apply(preview.operationId, { members: [] });
  await control.entered;
  const lockFile = createGroupStore(f.store);
  await expect(lockFile.locked(() => Promise.resolve('got it'))).rejects.toThrow(/group/i);
  control.open();
  await groups.wait(preview.operationId);
  await expect(lockFile.locked(() => Promise.resolve('free'))).resolves.toBe('free');
});

it('releases the lock when a run fails, so the next one can start', async () => {
  const f = await fixture();
  const { groups, control } = instrumented(f);
  const group = await groups.save(f.input);
  await f.editAll();
  control.failing.add(f.backend.repoId);
  const preview = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  await groups.apply(preview.operationId, { members: [] });
  expect((await groups.wait(preview.operationId)).state).toBe('failed');
  await expect(createGroupStore(f.store).locked(() => Promise.resolve(1))).resolves.toBe(1);
});

/* ---------- Races ---------- */
it('refuses a group edit from the same process during a run, then lets it through', async () => {
  const f = await fixture();
  const { groups, control, hold } = instrumented(f);
  const group = await groups.save(f.input);
  await f.editAll();
  hold();
  const preview = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  await groups.apply(preview.operationId, { members: [] });
  await control.entered;
  await expect(
    groups.save({ ...f.input, name: 'Renamed' }, group.id, group.revision),
  ).rejects.toThrow(/running/);
  control.open();
  expect((await groups.wait(preview.operationId)).state).toBe('completed');
  const renamed = await groups.save({ ...f.input, name: 'Renamed' }, group.id, group.revision);
  expect(renamed.name).toBe('Renamed');
});

it('refuses a group edit and a group delete from another process during a run', async () => {
  const f = await fixture();
  const { groups, control, hold } = instrumented(f);
  const group = await groups.save(f.input);
  await f.editAll();
  hold();
  const preview = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  await groups.apply(preview.operationId, { members: [] });
  await control.entered;
  const other = secondProcess(f.store);
  const edit = await other.groups
    .save({ ...f.input, name: 'Other' }, group.id, group.revision)
    .catch((error: unknown) => error as { code?: string });
  expect(edit).toMatchObject({ code: 'busy' });
  await expect(other.groups.remove(group.id, group.revision)).rejects.toMatchObject({
    code: 'busy',
  });
  control.open();
  expect((await groups.wait(preview.operationId)).state).toBe('completed');
  expect((await groups.list())[0]?.revision).toBe(group.revision);
});

it('refuses a second bulk run from another process, leaving it pending to try again', async () => {
  const f = await fixture();
  const { groups, control, hold, applied } = instrumented(f);
  const group = await groups.save(f.input);
  await f.editAll();
  const other = secondProcess(f.store);
  const second = await other.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    members: [f.frontend.repoId],
  });
  hold();
  const preview = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  await groups.apply(preview.operationId, { members: [] });
  await control.entered;
  await expect(other.groups.apply(second.operationId, { members: [] })).rejects.toMatchObject({
    code: 'busy',
  });
  expect(other.groups.status(second.operationId).state).toBe('pending');
  control.open();
  expect((await groups.wait(preview.operationId)).state).toBe('completed');
  expect(applied).toEqual([f.backend.repoId, f.frontend.repoId]);
  // Now free, but the first run changed everything it reviewed.
  await other.groups.apply(second.operationId, { members: [] });
  const stale = await other.groups.wait(second.operationId);
  expect(stale.state).toBe('failed');
  expect(stale.members.map((member) => member.state)).toEqual(['unattempted']);
});

it('refuses a second bulk run from the same process and does not double-apply', async () => {
  const f = await fixture();
  const { groups, control, hold, applied } = instrumented(f);
  const group = await groups.save(f.input);
  await f.editAll();
  hold();
  const first = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  const second = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  await groups.apply(first.operationId, { members: [] });
  await control.entered;
  await expect(groups.apply(second.operationId, { members: [] })).rejects.toMatchObject({
    code: 'busy',
  });
  await expect(groups.apply(first.operationId, { members: [] })).resolves.toMatchObject({
    state: 'running',
  });
  control.open();
  expect((await groups.wait(first.operationId)).state).toBe('completed');
  expect(applied).toHaveLength(2);
});

it('lets exactly one of two simultaneous applies run', async () => {
  const f = await fixture();
  const { groups } = instrumented(f);
  const other = secondProcess(f.store);
  const group = await groups.save(f.input);
  await f.editAll();
  const one = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  const two = await other.groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  const outcomes = await Promise.allSettled([
    groups.apply(one.operationId, { members: [] }),
    other.groups.apply(two.operationId, { members: [] }),
  ]);
  const settled = await Promise.all([
    groups.wait(one.operationId),
    other.groups.wait(two.operationId),
  ]);
  const completed = settled.filter((state) => state.state === 'completed');
  expect(completed).toHaveLength(1);
  // The loser either lost the lock outright or, if the winner had finished, found it stale.
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  const failed = settled.filter((state) => state.state === 'failed');
  expect(rejected.length + failed.length).toBe(1);
  for (const member of [f.backend, f.frontend])
    expect(await readFile(member.original, 'utf8')).toContain('edited()');
});

it('fails a group edit that holds the lock against a bulk apply as busy, not a raw lock error', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'refresh',
  });
  const held = await createGroupStore(f.store).acquire();
  await expect(
    f.dashboard.groups.apply(preview.operationId, { members: [] }),
  ).rejects.toMatchObject({ code: 'busy' });
  expect(f.dashboard.groups.status(preview.operationId).state).toBe('pending');
  await held.release();
  await f.dashboard.groups.apply(preview.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(preview.operationId)).state).toBe('completed');
});

it('stops before the next member when the lock is lost mid-run', async () => {
  const f = await fixture();
  const { groups, control, hold } = instrumented(f);
  const group = await groups.save(f.input);
  await f.editAll();
  hold();
  const preview = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  await groups.apply(preview.operationId, { members: [] });
  await control.entered;
  // Someone removes the lock. It is noticed on the next refresh, a few seconds later.
  await rm(join(f.store.root, 'groups.lock'), { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 7_000));
  control.open();
  const done = await groups.wait(preview.operationId);
  expect(done.state).toBe('failed');
  expect(done.members.map((member) => member.state)).toEqual(['completed', 'unattempted']);
  expect(done.error).toMatch(/lock/i);
  expect(await readFile(f.frontend.original, 'utf8')).toBe('class Frontend {}\n');
});

/* ---------- Stale revision ---------- */
it('rejects a stale revision at preview, at apply and at retry', async () => {
  const f = await fixture();
  const { groups, control } = instrumented(f);
  const group = await groups.save(f.input);
  await expect(
    groups.preview(group.id, { revision: 'old', intent: 'refresh' }),
  ).rejects.toMatchObject({ code: 'stale' });

  await f.editAll();
  const pending = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  const renamed = await groups.save({ ...f.input, name: 'Renamed' }, group.id, group.revision);
  await expect(groups.apply(pending.operationId, { members: [] })).rejects.toMatchObject({
    code: 'stale',
  });
  expect(await readFile(f.backend.original, 'utf8')).toBe('class Backend {}\n');
  groups.cancel(pending.operationId);

  control.failing.add(f.frontend.repoId);
  const failing = await groups.preview(group.id, {
    revision: renamed.revision,
    intent: 'restore',
  });
  await groups.apply(failing.operationId, { members: [] });
  expect((await groups.wait(failing.operationId)).state).toBe('failed');
  await groups.save({ ...f.input, name: 'Again' }, group.id, renamed.revision);
  await expect(groups.retry(failing.operationId)).rejects.toMatchObject({ code: 'stale' });
});

it('fails the run without writing when the group changes after the first check', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await f.editAll();
  const groupStore = createGroupStore(f.store);
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
  });
  // An edit written directly, as a process that ignored the protocol would.
  const { revision, ...record } = group;
  void revision;
  await groupStore.write({ ...record, name: 'Written behind the lock' });
  await expect(
    f.dashboard.groups.apply(preview.operationId, { members: [] }),
  ).rejects.toMatchObject({ code: 'stale' });
  expect(await readFile(f.backend.original, 'utf8')).toBe('class Backend {}\n');
});

/* ---------- Member subset ---------- */
it('runs only the chosen members', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await f.editAll();
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    members: [f.frontend.repoId],
  });
  expect(preview.members.map((member) => member.repoId)).toEqual([f.frontend.repoId]);
  expect(preview.writes).toEqual(['Frontend.ts']);
  await f.dashboard.groups.apply(preview.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(preview.operationId)).state).toBe('completed');
  expect(await readFile(f.frontend.original, 'utf8')).toContain('edited()');
  expect(await readFile(f.backend.original, 'utf8')).toBe('class Backend {}\n');
});

it('refuses a member that is not in the group', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save({ ...f.input, members: [f.input.members[0]] });
  await expect(
    f.dashboard.groups.preview(group.id, {
      revision: group.revision,
      intent: 'refresh',
      members: [f.frontend.repoId],
    }),
  ).rejects.toThrow(/not in this group/);
});

it('refuses a commit message on a pull', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await expect(
    f.dashboard.groups.preview(group.id, {
      revision: group.revision,
      intent: 'refresh',
      commitMessage: 'nothing to commit',
    }),
  ).rejects.toThrow();
});

/* ---------- Partial failure ---------- */
it('stops at the first failure when the rule is on and retries only what is left', async () => {
  const f = await fixture();
  const { groups, control, applied } = instrumented(f);
  const group = await groups.save(f.input);
  await f.editAll();
  control.failing.add(f.backend.repoId);
  const preview = await groups.preview(group.id, { revision: group.revision, intent: 'restore' });
  await groups.apply(preview.operationId, { members: [] });
  const failed = await groups.wait(preview.operationId);
  expect(failed.state).toBe('failed');
  expect(failed.error).toContain('0 succeeded / 1 failed / 1 unattempted');
  expect(failed.members.map((member) => member.state)).toEqual(['failed', 'unattempted']);
  expect(await readFile(f.frontend.original, 'utf8')).toBe('class Frontend {}\n');
  control.failing.clear();
  const retry = await groups.retry(preview.operationId);
  expect(retry.members).toHaveLength(2);
  await groups.apply(retry.operationId, { members: [] });
  expect((await groups.wait(retry.operationId)).state).toBe('completed');
  expect(applied.filter((id) => id === f.backend.repoId)).toHaveLength(2);
  expect(await readFile(f.frontend.original, 'utf8')).toContain('edited()');
});

it('carries on after a failure when the rule is off and reports the failure', async () => {
  const f = await fixture();
  const { groups, control } = instrumented(f);
  const group = await groups.save(f.input);
  await f.editAll();
  control.failing.add(f.backend.repoId);
  const preview = await groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    stopOnGuardFailure: false,
  });
  await groups.apply(preview.operationId, { members: [] });
  const done = await groups.wait(preview.operationId);
  expect(done.state).toBe('failed');
  expect(done.error).toContain('1 member failed');
  expect(done.members.map((member) => member.state)).toEqual(['failed', 'completed']);
  expect(await readFile(f.frontend.original, 'utf8')).toContain('edited()');
  control.failing.clear();
  const retry = await groups.retry(preview.operationId);
  expect(retry.members.map((member) => member.repoId)).toEqual([f.backend.repoId]);
  await groups.apply(retry.operationId, { members: [] });
  expect((await groups.wait(retry.operationId)).state).toBe('completed');
  expect(await readFile(f.backend.original, 'utf8')).toContain('edited()');
});

it('skips a member that cannot be prepared when the rule is off, and rejects when it is on', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await f.editAll();
  await rm(f.backend.destination, { recursive: true });
  await expect(
    f.dashboard.groups.preview(group.id, { revision: group.revision, intent: 'restore' }),
  ).rejects.toThrow(/manifest|missing/i);
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    stopOnGuardFailure: false,
  });
  expect(preview.canApply).toBe(true);
  expect(preview.warnings.join()).toMatch(/Skipped Backend/);
  expect(preview.members.map((member) => member.state)).toEqual(['unattempted', 'pending']);
  await f.dashboard.groups.apply(preview.operationId, { members: [] });
  const done = await f.dashboard.groups.wait(preview.operationId);
  expect(done.state).toBe('completed');
  expect(done.members.map((member) => member.state)).toEqual(['unattempted', 'completed']);
});

it('cannot apply when every member is skipped', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await rm(f.backend.destination, { recursive: true });
  await rm(f.frontend.destination, { recursive: true });
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    stopOnGuardFailure: false,
  });
  expect(preview.canApply).toBe(false);
  await expect(
    f.dashboard.groups.apply(preview.operationId, { members: [] }),
  ).rejects.toMatchObject({ code: 'conflict' });
});

it('still needs an acknowledgement for a deletion in a chosen member', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await rm(f.frontend.cloaked);
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    members: [f.frontend.repoId],
    commitMessage: 'Remove frontend',
  });
  await expect(f.dashboard.groups.apply(preview.operationId, { members: [] })).rejects.toThrow(
    /deletions/,
  );
  await f.dashboard.groups.apply(preview.operationId, {
    members: [{ repoId: f.frontend.repoId, deletions: true }],
  });
  expect((await f.dashboard.groups.wait(preview.operationId)).state).toBe('completed');
  await expect(readFile(f.frontend.original)).rejects.toThrow();
  expect((await f.frontend.git('log', '-1', '--format=%s')).trim()).toBe('Remove frontend');
  expect((await f.frontend.git('status', '--porcelain')).trim()).toBe('');
});

/* ---------- Commits ---------- */
it('commits each member, records it in history, and leaves other staged work alone', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await f.editAll();
  await writeFile(join(f.backend.worktree, 'unrelated.txt'), 'staged by the user\n');
  await f.backend.git('add', 'unrelated.txt');
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    commitMessage: 'Export claims',
  });
  await f.dashboard.groups.apply(preview.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(preview.operationId)).state).toBe('completed');
  for (const member of [f.backend, f.frontend]) {
    expect((await member.git('log', '-1', '--format=%s')).trim()).toBe('Export claims');
    expect(await member.git('show', '--name-only', '--format=', 'HEAD')).toBe(
      `${member.name}.ts\n`,
    );
  }
  expect((await f.backend.git('status', '--porcelain')).trim()).toBe('A  unrelated.txt');
  const { events } = await f.dashboard.sync.audit.list({ limit: 20 });
  expect(events.filter((event) => event.detail?.startsWith('Committed '))).toHaveLength(2);
});

it('does not run repository hooks for a bulk commit', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await f.editAll();
  const proof = join(f.root, 'hook-ran');
  await writeFile(
    join(f.backend.worktree, '.git/hooks/pre-commit'),
    `#!/bin/sh\ntouch "${proof}"\nexit 1\n`,
    { mode: 0o755 },
  );
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    commitMessage: 'No hooks',
  });
  await f.dashboard.groups.apply(preview.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(preview.operationId)).state).toBe('completed');
  await expect(readFile(proof)).rejects.toThrow();
  expect((await f.backend.git('log', '-1', '--format=%s')).trim()).toBe('No hooks');
});

it('restores real names in a bulk commit message', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await f.editAll();
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    members: [f.backend.repoId],
    commitMessage: 'Update SafeBackend',
  });
  await f.dashboard.groups.apply(preview.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(preview.operationId)).state).toBe('completed');
  expect((await f.backend.git('log', '-1', '--format=%s')).trim()).toBe('Update Backend');
});

it('refuses a commit message it cannot restore before writing any member', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await f.editAll();
  const before = await readFile(f.backend.original, 'utf8');
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    commitMessage: 'Update SafeBackend',
  });
  await f.dashboard.groups.apply(preview.operationId, { members: [] });
  const done = await f.dashboard.groups.wait(preview.operationId);
  expect(done.state).toBe('failed');
  expect(done.error).toMatch(/commit message/);
  expect(await readFile(f.backend.original, 'utf8')).toBe(before);
});

it('retries a failed commit and commits what the earlier attempt wrote', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  await f.editAll();
  const lock = join(f.frontend.worktree, '.git/index.lock');
  await writeFile(lock, '');
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
    commitMessage: 'Export claims',
  });
  await f.dashboard.groups.apply(preview.operationId, { members: [] });
  const failed = await f.dashboard.groups.wait(preview.operationId);
  expect(failed.state).toBe('failed');
  expect(failed.members.map((member) => member.state)).toEqual(['completed', 'failed']);
  // Written, not committed.
  expect(await readFile(f.frontend.original, 'utf8')).toContain('edited()');
  expect((await f.frontend.git('log', '-1', '--format=%s')).trim()).toBe('initial');
  await rm(lock);
  const retry = await f.dashboard.groups.retry(preview.operationId);
  expect(retry.members.map((member) => member.repoId)).toEqual([f.frontend.repoId]);
  expect(retry.writes).toEqual([]);
  await f.dashboard.groups.apply(retry.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(retry.operationId)).state).toBe('completed');
  expect((await f.frontend.git('log', '-1', '--format=%s')).trim()).toBe('Export claims');
  expect((await f.frontend.git('status', '--porcelain')).trim()).toBe('');
});

/* ---------- commitPaths ---------- */
it('treats paths literally, skips ignored files and commits nothing when nothing changed', async () => {
  const f = await fixture();
  const { worktree: root, git } = f.backend;
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  await git('add', '.gitignore');
  await git('commit', '-qm', 'ignore');
  await writeFile(join(root, 'a[1].ts'), 'literal\n');
  await writeFile(join(root, 'a1.ts'), 'must not be staged by a glob\n');
  await writeFile(join(root, 'ignored.txt'), 'ignored\n');
  const result = await commitPaths(root, ['a[1].ts', 'ignored.txt'], 'Literal');
  expect(result.commit).toMatch(/^[0-9a-f]+$/);
  expect(result.warnings).toEqual(['1 ignored file was not staged']);
  expect(await git('show', '--name-only', '--format=', 'HEAD')).toBe('a[1].ts\n');
  expect((await git('status', '--porcelain')).trim()).toBe('?? a1.ts');

  const head = (await git('rev-parse', 'HEAD')).trim();
  expect((await commitPaths(root, ['a[1].ts'], 'Nothing new')).commit).toBeUndefined();
  expect((await git('rev-parse', 'HEAD')).trim()).toBe(head);
  expect((await commitPaths(root, [], 'Empty')).commit).toBeUndefined();
});
