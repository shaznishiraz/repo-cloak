import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/commands/dashboard.js';
import { createDashboardSync } from '../../src/commands/dashboard-sync.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak wizard ')));
  roots.push(root);
  const source = join(root, 'Acme');
  const destination = join(root, 'workspace');
  await mkdir(source);
  const store = createStore(join(root, 'store'));
  const services = createSyncServices(source, store);
  await services.git.runGit(source, ['init', '-b', 'main']);
  await services.git.runGit(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'initial',
  ]);
  await writeFile(join(source, 'Acme.ts'), 'class Acme {}');
  const dashboard = createDashboard(store, source);
  const { repoId = '' } = await dashboard.context();
  const profile = await dashboard.saveProfile({
    scope: { kind: 'global' },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'names',
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    },
  });
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  const input = {
    intent: 'create',
    repoId,
    worktree: source,
    destination,
    profiles: [{ id: profile.id, scope: profile.scope }],
    files: ['Acme.ts'],
  };
  return { root, source, destination, store, services, dashboard, repoId, profile, input };
}

it('previews without writes, creates once, refreshes, and restores saved names', async () => {
  const f = await fixture();
  const before = await readdir(f.root, { recursive: true });
  const preview = await f.dashboard.sync.preview(f.input);
  expect(preview.canApply).toBe(true);
  expect(await readdir(f.root, { recursive: true })).toEqual(before);
  expect(JSON.stringify(preview)).not.toContain('class Acme');
  const operation = await f.dashboard.sync.apply(preview.operationId, {});
  expect(operation.state).toBe('running');
  const result = await f.dashboard.sync.wait(preview.operationId);
  expect(result.state).toBe('completed');
  expect(await f.dashboard.sync.apply(preview.operationId, {})).toEqual(result);
  expect(await readFile(join(f.destination, 'Northwind.ts'), 'utf8')).toBe('class Northwind {}');
  const workspaceId = result.result?.workspaceId ?? '';
  await writeFile(join(f.source, 'Acme.ts'), 'class Acme { source = true }');
  const refresh = await f.dashboard.sync.preview({
    intent: 'refresh',
    repoId: f.repoId,
    workspaceId,
    worktree: f.source,
  });
  await f.dashboard.sync.apply(refresh.operationId, {});
  await f.dashboard.sync.wait(refresh.operationId);
  expect(await readFile(join(f.destination, 'Northwind.ts'), 'utf8')).toContain('source = true');
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { agent = true }');
  const restore = await f.dashboard.sync.preview({
    intent: 'restore',
    repoId: f.repoId,
    workspaceId,
    worktree: f.source,
  });
  await f.dashboard.sync.apply(restore.operationId, {});
  expect((await f.dashboard.sync.wait(restore.operationId)).state).toBe('completed');
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme { agent = true }');
});

it('rejects stale source, profile, HEAD, destination and inventory changes without applying', async () => {
  for (const change of ['source', 'profile', 'head', 'destination', 'inventory', 'config']) {
    const f = await fixture();
    const preview = await f.dashboard.sync.preview(f.input);
    if (change === 'source') await writeFile(join(f.source, 'Acme.ts'), 'changed');
    if (change === 'profile')
      await f.dashboard.saveProfile({
        ...f.profile,
        profile: { ...f.profile.profile, description: 'edited' },
      });
    if (change === 'head') await f.services.git.runGit(f.source, ['checkout', '-b', 'other']);
    if (change === 'destination') await mkdir(f.destination);
    if (change === 'config')
      await f.services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: true });
    if (change === 'inventory') await writeFile(join(f.source, 'added.ts'), 'new');
    await f.dashboard.sync.apply(preview.operationId, {});
    const result = await f.dashboard.sync.wait(preview.operationId);
    expect(result.state, change).toBe('failed');
    expect(result.code, change).toBe('stale');
    await expect(readFile(join(f.destination, '.repo-cloak/manifest.json'))).rejects.toThrow();
  }
});

it('validates scope, paths, input unions and requires deletion acknowledgements', async () => {
  const f = await fixture();
  await expect(f.dashboard.sync.preview({ ...f.input, files: ['../outside'] })).rejects.toThrow();
  await expect(f.dashboard.sync.preview({ ...f.input, force: true })).rejects.toThrow();
  await expect(
    f.dashboard.sync.preview({
      ...f.input,
      profiles: [{ id: f.profile.id, scope: { kind: 'repo', repoId: 'ffffffffffffffff' } }],
    }),
  ).rejects.toThrow();
  const preview = await f.dashboard.sync.preview(f.input);
  await f.dashboard.sync.apply(preview.operationId, {});
  const created = await f.dashboard.sync.wait(preview.operationId);
  await rm(join(f.destination, 'Northwind.ts'));
  const deletion = await f.dashboard.sync.preview({
    intent: 'restore',
    repoId: f.repoId,
    workspaceId: created.result?.workspaceId,
    worktree: f.source,
  });
  expect(deletion.deletes).toEqual(['Acme.ts']);
  await expect(f.dashboard.sync.apply(deletion.operationId, {})).rejects.toThrow(/delet/i);
  await f.dashboard.sync.apply(deletion.operationId, { deletions: true });
  expect((await f.dashboard.sync.wait(deletion.operationId)).state).toBe('completed');
});

it('expires and cancels previews and enforces count and byte limits', async () => {
  const f = await fixture();
  let now = 0;
  const sync = createDashboardSync(f.store, { now: () => now, ttl: 10, maxPending: 1 });
  const preview = await sync.preview(f.input);
  await expect(sync.preview(f.input)).rejects.toThrow(/limit/i);
  now = 11;
  await expect(sync.apply(preview.operationId, {})).rejects.toThrow(/expired/i);
  const next = await sync.preview(f.input);
  sync.cancel(next.operationId);
  await expect(sync.apply(next.operationId, {})).rejects.toThrow(/cancelled/i);
  const tiny = createDashboardSync(f.store, { maxBytes: 1 });
  await expect(tiny.preview(f.input)).rejects.toThrow(/limit/i);
  sync.close();
  tiny.close();
});

async function createWorkspace(f: Awaited<ReturnType<typeof fixture>>) {
  const preview = await f.dashboard.sync.preview(f.input);
  await f.dashboard.sync.apply(preview.operationId, {});
  const result = await f.dashboard.sync.wait(preview.operationId);
  expect(result.state).toBe('completed');
  return result.result?.workspaceId ?? '';
}

it('blocks conflicts by default, previews skip and force policies, and requires force confirmation', async () => {
  const f = await fixture();
  const workspaceId = await createWorkspace(f);
  await writeFile(join(f.source, 'Acme.ts'), 'class Acme { source = true }');
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { agent = true }');
  await writeFile(join(f.destination, 'new.txt'), 'Northwind added');
  const input = { intent: 'restore', repoId: f.repoId, workspaceId, worktree: f.source };
  const blocked = await f.dashboard.sync.preview(input);
  expect(blocked.canApply).toBe(false);
  expect(blocked.conflicts).toEqual(['Northwind.ts']);
  await expect(f.dashboard.sync.apply(blocked.operationId, {})).rejects.toThrow(/conflicts/);
  const skipped = await f.dashboard.sync.preview({ ...input, policy: 'skip' });
  await f.dashboard.sync.apply(skipped.operationId, {});
  expect((await f.dashboard.sync.wait(skipped.operationId)).state).toBe('completed');
  expect(await readFile(join(f.source, 'new.txt'), 'utf8')).toBe('Acme added');
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toContain('source = true');
  const forced = await f.dashboard.sync.preview({ ...input, policy: 'force' });
  expect(forced.conflicts).toEqual(['Northwind.ts']);
  await expect(f.dashboard.sync.apply(forced.operationId, {})).rejects.toThrow(/forced/);
  await f.dashboard.sync.apply(forced.operationId, { force: true });
  expect((await f.dashboard.sync.wait(forced.operationId)).state).toBe('completed');
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toContain('agent = true');
});

it('preserves refresh edits, reports both-side conflicts, and confirms changed profiles', async () => {
  const f = await fixture();
  const workspaceId = await createWorkspace(f);
  const input = { intent: 'refresh', repoId: f.repoId, workspaceId, worktree: f.source };
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { local = true }');
  const preserved = await f.dashboard.sync.preview(input);
  await f.dashboard.sync.apply(preserved.operationId, {});
  expect((await f.dashboard.sync.wait(preserved.operationId)).state).toBe('completed');
  expect(await readFile(join(f.destination, 'Northwind.ts'), 'utf8')).toContain('local = true');
  await writeFile(join(f.source, 'Acme.ts'), 'class Acme { other = true }');
  const blocked = await f.dashboard.sync.preview(input);
  expect(blocked.canApply).toBe(false);
  expect(blocked.conflicts.join()).toContain('both');
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind {}');
  await f.dashboard.saveProfile({
    ...f.profile,
    profile: { ...f.profile.profile, description: 'changed' },
  });
  const changed = await f.dashboard.sync.preview(input);
  expect(changed.profileChanges).toEqual(['names']);
  await expect(f.dashboard.sync.apply(changed.operationId, {})).rejects.toThrow(/profiles/);
  await f.dashboard.sync.apply(changed.operationId, { profiles: true });
  expect((await f.dashboard.sync.wait(changed.operationId)).state).toBe('completed');
});

it('creates new worktrees only on apply and supports existing secondary worktrees', async () => {
  const f = await fixture();
  await f.services.git.runGit(f.source, ['add', 'Acme.ts']);
  await f.services.git.runGit(f.source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'file',
  ]);
  const workspaceId = await createWorkspace(f);
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { review = true }');
  const path = join(f.root, 'review');
  const input = { intent: 'restore', repoId: f.repoId, workspaceId, newWorktree: 'review', path };
  const before = await f.services.git.worktrees(f.source);
  const preview = await f.dashboard.sync.preview(input);
  expect(await f.services.git.worktrees(f.source)).toEqual(before);
  await f.dashboard.sync.apply(preview.operationId, {});
  expect((await f.dashboard.sync.wait(preview.operationId)).state).toBe('completed');
  expect(await readFile(join(path, 'Acme.ts'), 'utf8')).toContain('review = true');
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme {}');
  expect((await createDashboard(f.store, path).context()).worktree).toBe(path);
  expect(await f.dashboard.sync.worktrees(f.repoId)).toHaveLength(2);
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { second = true }');
  const existing = await f.dashboard.sync.preview({
    intent: 'restore',
    repoId: f.repoId,
    workspaceId,
    worktree: path,
  });
  await f.dashboard.sync.apply(existing.operationId, {});
  expect((await f.dashboard.sync.wait(existing.operationId)).state).toBe('completed');
  expect(await readFile(join(path, 'Acme.ts'), 'utf8')).toContain('second = true');
});

it('validates commits and selections, honors profile scope, and paginates eligible files', async () => {
  const f = await fixture();
  const second = await f.dashboard.saveProfile({
    scope: { kind: 'repo', repoId: f.repoId },
    profile: {
      ...f.profile.profile,
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Other' }],
    },
  });
  const preview = await f.dashboard.sync.preview({
    ...f.input,
    profiles: [{ id: second.id, scope: second.scope }],
  });
  expect(preview.writes).toEqual(['Other.ts']);
  await expect(
    f.dashboard.sync.preview({ ...f.input, profiles: [f.input.profiles[0], f.input.profiles[0]] }),
  ).rejects.toThrow();
  await expect(
    f.dashboard.sync.preview({ ...f.input, files: [], commits: ['missing-ref'] }),
  ).rejects.toThrow();
  await expect(f.dashboard.sync.preview({ ...f.input, files: [] })).rejects.toThrow(/Choose files/);
  await f.services.git.runGit(f.source, ['add', 'Acme.ts']);
  await f.services.git.runGit(f.source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'file',
  ]);
  await writeFile(join(f.source, 'Acme.ts'), 'class Acme { working = true }');
  const commit = await f.dashboard.sync.preview({ ...f.input, files: [], commits: ['HEAD'] });
  await f.dashboard.sync.apply(commit.operationId, {});
  expect((await f.dashboard.sync.wait(commit.operationId)).state).toBe('completed');
  expect(await readFile(join(f.destination, 'Northwind.ts'), 'utf8')).toContain('working = true');
  await mkdir(join(f.source, 'node_modules'));
  await writeFile(join(f.source, 'node_modules', 'hidden'), 'private');
  await Promise.all(
    Array.from({ length: 201 }, (_, i) => writeFile(join(f.source, `file-${i}.txt`), 'test')),
  );
  const page = await f.dashboard.sync.selection(f.repoId, f.source);
  expect(page.files).toHaveLength(200);
  expect(page.next).toBe(200);
  expect(page.files.join()).not.toContain('node_modules');
  expect(page.working).toHaveLength(200);
  expect(page.workingCount).toBe(202);
  expect(page.workingNext).toBe(200);
  expect(page.working.join()).not.toContain('node_modules');
  expect((await f.dashboard.sync.selection(f.repoId, f.source, 0, 'ACME.TS')).files).toEqual([
    'Acme.ts',
  ]);
  expect((await f.dashboard.sync.selection(f.repoId, f.source, page.next ?? 0)).files).toHaveLength(
    2,
  );
});

it('creates an independent Git repository with anonymized files using default settings', async () => {
  const f = await fixture();
  await f.services.store.saveConfig({ kind: 'config', schemaVersion: 1 });
  const preview = await f.dashboard.sync.preview(f.input);
  await f.dashboard.sync.apply(preview.operationId, {});
  const result = await f.dashboard.sync.wait(preview.operationId);
  expect(result.state).toBe('completed');
  expect((await f.services.git.repoState(f.destination)).path).toBe(f.destination);
  expect(await f.services.git.runGit(f.destination, ['ls-files'])).toContain('Northwind.ts');
  expect(await f.services.git.runGit(f.destination, ['status', '--porcelain'])).toBe('');
  const detail = await f.dashboard.workspace(f.repoId, result.result?.workspaceId ?? '');
  expect(detail.trackedFiles).toBe(1);
});

it('invalidates restore previews when workspace bytes or the authenticated manifest change', async () => {
  const f = await fixture();
  const workspaceId = await createWorkspace(f);
  const input = { intent: 'restore', repoId: f.repoId, workspaceId, worktree: f.source };
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { first = true }');
  const first = await f.dashboard.sync.preview(input);
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { second = true }');
  await f.dashboard.sync.apply(first.operationId, {});
  expect(await f.dashboard.sync.wait(first.operationId)).toMatchObject({
    state: 'failed',
    code: 'stale',
  });
  const second = await f.dashboard.sync.preview(input);
  const snapshot = await f.services.store.readSnapshot(f.destination);
  if (!snapshot) throw new Error('Missing fixture manifest');
  await writeFile(
    join(f.destination, '.repo-cloak/manifest.json'),
    await f.services.store.sealManifest({
      ...snapshot,
      writes: [],
      deletes: [],
      preview: [],
      warnings: [],
      profileChanges: [],
      previousRules: snapshot.data.rules,
    }),
  );
  await f.dashboard.sync.apply(second.operationId, {});
  expect(await f.dashboard.sync.wait(second.operationId)).toMatchObject({
    state: 'failed',
    code: 'stale',
  });
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme {}');
});

it('uses saved restoration rules after profile edits and refuses foreign worktrees or workspace IDs', async () => {
  const f = await fixture();
  const other = await fixture();
  const workspaceId = await createWorkspace(f);
  await expect(
    f.dashboard.sync.preview({
      intent: 'restore',
      repoId: f.repoId,
      workspaceId,
      worktree: other.source,
    }),
  ).rejects.toThrow(/belonging/);
  await expect(
    f.dashboard.sync.preview({ intent: 'restore', repoId: f.repoId, workspaceId: '__proto__' }),
  ).rejects.toThrow(/not registered/);
  await f.dashboard.saveProfile({
    ...f.profile,
    profile: {
      ...f.profile.profile,
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Other' }],
    },
  });
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { savedRules = true }');
  const preview = await f.dashboard.sync.preview({
    intent: 'restore',
    repoId: f.repoId,
    workspaceId,
    worktree: f.source,
  });
  await f.dashboard.sync.apply(preview.operationId, {});
  expect((await f.dashboard.sync.wait(preview.operationId)).state).toBe('completed');
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toContain('Acme { savedRules');
});

it('returns a fresh full inventory independent of commit and working-change loading', async () => {
  const f = await fixture();
  await writeFile(join(f.source, '.gitignore'), '.env\n');
  await writeFile(join(f.source, '.env'), 'synthetic');
  const first = await f.dashboard.sync.inventory(f.repoId, f.source);
  expect(first.files).toContain('Acme.ts');
  expect(first.files).not.toContain('.env');
  expect(first).not.toHaveProperty('commits');
  expect((await f.dashboard.sync.inventory(f.repoId, f.source, [], false)).files).toContain('.env');
  await writeFile(join(f.source, 'new.ts'), 'new');
  expect((await f.dashboard.sync.inventory(f.repoId, f.source)).files).toContain('new.ts');
  await expect(f.dashboard.sync.inventory(f.repoId, f.root)).rejects.toThrow();
  expect(await f.dashboard.sync.selectionContext(f.repoId, f.source)).toMatchObject({
    working: expect.arrayContaining(['Acme.ts', 'new.ts']),
    commits: expect.any(Array),
  });
});
