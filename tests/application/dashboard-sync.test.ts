import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { createDashboardSync } from '../../src/application/dashboard-sync.js';
import { prepareSync } from '../../src/application/sync.js';

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
  await expect(f.dashboard.sync.preview(f.input)).rejects.toThrow('empty destination');
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
  for (const change of [
    'source',
    'profile',
    'head',
    'destination',
    'inventory',
    'config',
    'group',
  ]) {
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
    if (change === 'group') {
      await mkdir(join(f.root, '.repo-cloak'));
      await writeFile(join(f.root, '.repo-cloak/group.json'), '{}');
    }
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
  await expect(f.dashboard.sync.preview({ ...f.input, files: [] })).rejects.toThrow(/Select files/);
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

it.each(['listing order', 'excluded build files'])(
  'pushes edited workspace files despite changes to %s',
  async (change) => {
    const f = await fixture();
    await createWorkspace(f);
    await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { edited = true }');
    let reads = 0;
    const local = {
      ...f.services,
      cwd: f.destination,
      files: {
        ...f.services.files,
        async readWorkspace(root: string, paths: string[], concurrency: number) {
          const result = await f.services.files.readWorkspace(root, paths, concurrency);
          if (root === f.destination && paths.length && change === 'listing order') {
            result.paths.sort();
            if (++reads % 2 === 0) result.paths.reverse();
          }
          return result;
        },
      },
    };
    const prepared = await prepareSync(local, '2.0.0', 'push', { worktree: f.source });
    if (change === 'excluded build files') {
      await mkdir(join(f.destination, 'dist'));
      await writeFile(join(f.destination, 'dist', 'bundle.js'), 'generated output');
    }
    await prepared.apply();
    expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme { edited = true }');
    expect(await readdir(f.source)).not.toContain('dist');
  },
);

it('allows ignored workspace build artifacts appearing after a dashboard restore preview', async () => {
  const f = await fixture();
  const workspaceId = await createWorkspace(f);
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { edited = true }');
  const preview = await f.dashboard.sync.preview({
    intent: 'restore',
    repoId: f.repoId,
    workspaceId,
    worktree: f.source,
  });
  await mkdir(join(f.destination, 'node_modules'));
  await writeFile(join(f.destination, 'node_modules', 'cache.js'), 'ignored output');
  await f.dashboard.sync.apply(preview.operationId, {});
  expect((await f.dashboard.sync.wait(preview.operationId)).state).toBe('completed');
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme { edited = true }');
  expect(await readdir(f.source)).not.toContain('node_modules');
});

it.each(['added', 'deleted'])(
  'rejects a genuinely %s workspace file before pushing',
  async (change) => {
    const f = await fixture();
    await createWorkspace(f);
    await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { edited = true }');
    const prepared = await prepareSync({ ...f.services, cwd: f.destination }, '2.0.0', 'push', {
      worktree: f.source,
    });
    if (change === 'added') await writeFile(join(f.destination, 'new.txt'), 'latest content');
    else await rm(join(f.destination, 'Northwind.ts'));
    await expect(prepared.apply()).rejects.toThrow(
      'Workspace files changed while preparing restore',
    );
    expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme {}');
  },
);

it('force-pushes the latest workspace snapshot after rejecting a genuinely stale preview', async () => {
  const f = await fixture();
  const workspaceId = await createWorkspace(f);
  await writeFile(join(f.source, 'Acme.ts'), 'class Acme { source = true }');
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { first = true }');
  const input = {
    intent: 'restore',
    repoId: f.repoId,
    workspaceId,
    worktree: f.source,
    policy: 'force',
  };
  const stale = await f.dashboard.sync.preview(input);
  await writeFile(join(f.destination, 'Northwind.ts'), 'class Northwind { latest = true }');
  await f.dashboard.sync.apply(stale.operationId, { force: true });
  expect(await f.dashboard.sync.wait(stale.operationId)).toMatchObject({
    state: 'failed',
    code: 'stale',
  });
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme { source = true }');
  const fresh = await f.dashboard.sync.preview(input);
  await f.dashboard.sync.apply(fresh.operationId, { force: true });
  expect((await f.dashboard.sync.wait(fresh.operationId)).state).toBe('completed');
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme { latest = true }');
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

it('exports small changes from large source schemas outside the cloak selection', async () => {
  const f = await fixture();
  const workspaceId = await createWorkspace(f);
  const path = 'schema.graphql';
  const context = '  unchangedField: String # retained schema context\n'.repeat(25_000);
  for (const field of ['previous: String', 'updated: Acme']) {
    await writeFile(join(f.source, path), `type Acme {\n${context}  ${field}\n}\n`);
    await f.services.git.runGit(f.source, ['add', '--', path]);
    await f.services.git.runGit(f.source, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      field,
    ]);
  }
  const commit = (await f.services.git.repoState(f.source)).commit ?? '';
  const listing = await f.dashboard.sync.exportFiles(f.repoId, workspaceId, { commit });
  const selected = listing.files.find((file) => file.path === path);
  expect(selected).toMatchObject({ added: 1, removed: 1 });
  const diff = await f.dashboard.sync.exportDiff(f.repoId, workspaceId, {
    commit,
    indexes: [selected?.index ?? -1],
  });
  expect(diff.patch).toContain('-  previous: String');
  expect(diff.patch).toContain('+  updated: Northwind');
  expect(diff.patch).not.toContain('Acme');
  expect(Buffer.byteLength(diff.patch)).toBeLessThan(1024);
  expect(await readdir(f.destination)).not.toContain(path);
});

it('exports commit paths outside the workspace with an explicit exclusion override and older commit lookup', async () => {
  const f = await fixture();
  const workspaceId = await createWorkspace(f);
  await writeFile(join(f.source, 'Acme-extra.ts'), 'class AcmeExtra {}\n');
  await writeFile(join(f.source, 'Acme-private.txt'), 'Acme private\n');
  await writeFile(join(f.source, 'image.bin'), Buffer.from([0, 255, 1]));
  await f.services.git.runGit(f.source, ['add', '.']);
  await f.services.git.runGit(f.source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'changes',
  ]);
  await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['Acme-private.txt'] });
  const commits = await f.dashboard.sync.exportCommits(f.repoId, workspaceId);
  const commit = commits[0]?.id ?? '';
  expect((await f.dashboard.sync.exportCommits(f.repoId, workspaceId, 1))[0]?.id).toBe(
    commits[1]?.id,
  );
  expect((await f.dashboard.sync.exportCommits(f.repoId, workspaceId, 0, 'HEAD~1'))[0]?.id).toBe(
    commits[1]?.id,
  );
  const listing = await f.dashboard.sync.exportFiles(f.repoId, workspaceId, { commit });
  const extra = listing.files.find((file) => file.path === 'Northwind-extra.ts');
  const excluded = listing.files.find((file) => file.excluded);
  const binary = listing.files.find((file) => file.path === 'image.bin');
  expect(extra).toMatchObject({ added: 1, removed: 0, excluded: false });
  expect(excluded?.path).toBe('Northwind-private.txt');
  const indexes = [extra?.index ?? -1];
  const diff = await f.dashboard.sync.exportDiff(f.repoId, workspaceId, { commit, indexes });
  expect(diff.patch).toContain('class NorthwindExtra');
  expect(diff.patch).toContain('--- /dev/null');
  expect(diff.patch).not.toContain('Acme');
  await expect(
    f.dashboard.sync.exportDiff(f.repoId, workspaceId, { commit, indexes: [excluded?.index] }),
  ).rejects.toThrow('override');
  expect(
    (
      await f.dashboard.sync.exportDiff(f.repoId, workspaceId, {
        commit,
        indexes: [excluded?.index],
        includeExcluded: true,
      })
    ).patch,
  ).toContain('Northwind private');
  expect(
    (await f.dashboard.sync.exportDiff(f.repoId, workspaceId, { commit, indexes: [binary?.index] }))
      .skipped,
  ).toBe(1);
  await expect(
    f.dashboard.sync.exportDiff(f.repoId, workspaceId, { commit, indexes: [4999] }),
  ).rejects.toThrow('not in this commit');
  expect(await f.dashboard.sync.exclusions(f.repoId)).toEqual({ patterns: ['Acme-private.txt'] });
  await expect(
    f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['!secret'] }),
  ).rejects.toThrow('negation');
  expect((await f.dashboard.sync.inventory(f.repoId, f.source)).files).not.toContain(
    'Acme-private.txt',
  );
});
