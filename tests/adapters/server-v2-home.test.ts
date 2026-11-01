import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { countLines, homeRoutes } from '../../src/adapters/server-v2/home.js';
import { createDashboardServer } from '../../src/adapters/server.js';
import { createGroupStore } from '../../src/adapters/groups.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import type { createDesktop } from '../../src/adapters/desktop.js';
import { prepareSync } from '../../src/application/sync.js';
import type { CommitEntry, OperationState } from '../../src/web/api/contracts.js';
import type {
  GroupDetailView,
  GroupOperationView,
  TargetPreview,
  WorkspaceDetailView,
} from '../../src/web/api/contracts.js';

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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak home ')));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = createStore(join(root, 'store'));
  const open = vi.fn(() => Promise.resolve());
  const desktop = {
    availability: () => Promise.resolve({ folder: { label: 'Reveal in Finder', available: true } }),
    open,
  } as unknown as ReturnType<typeof createDesktop>;

  async function repo(name: string) {
    const source = join(root, name);
    await mkdir(source);
    const services = createSyncServices(source, store);
    const git = (...args: string[]) => services.git.runGit(source, args);
    await git('init', '-b', 'main');
    await writeFile(join(source, 'Acme.ts'), 'class Acme {}\nline two\n');
    await writeFile(join(source, 'Other.ts'), 'other\n');
    await git('add', '-A');
    await git(...identity, 'commit', '-qm', 'first');
    return { source, services, git };
  }
  const first = await repo('source');
  const services = first.services;
  await services.store.saveConfig({
    kind: 'config',
    schemaVersion: 1,
    initGit: false,
    workspacesRoot: join(root, 'cloaks'),
  });
  await services.profiles.save(
    { kind: 'global' },
    {
      kind: 'profile',
      schemaVersion: 1,
      name: 'sample',
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    },
  );
  async function cloak(source: string, to: string) {
    const prepared = await prepareSync(createSyncServices(source, store), '2.0.0', 'push', {
      profiles: ['sample'],
      files: ['Acme.ts', 'Other.ts'],
      to,
    });
    await prepared.apply();
    return prepared.result;
  }
  const workspace = join(root, 'cloak-one');
  const made = await cloak(first.source, workspace);
  const dashboard = createDashboard(store, first.source, desktop);
  const repoId = (await dashboard.context()).repoId as string;
  const server = createDashboardServer(dashboard, 'test-token', resolve('src/web'));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: {
        Authorization: 'Bearer test-token',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: (await response.json()) as T };
  };
  const id = made.workspaceId;
  const base = `/api/v2/workspaces/${repoId}/${encodeURIComponent(id)}`;
  const settle = async (operationId: string) => {
    for (let tries = 0; tries < 200; tries++) {
      const { data } = await call<OperationState>('GET', `/api/v2/operations/${operationId}`);
      if (data.state !== 'running' && data.state !== 'pending') return data;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error('Operation did not finish');
  };
  const settleGroup = async (operationId: string) => {
    for (let tries = 0; tries < 200; tries++) {
      const { data } = await call<GroupOperationView>(
        'GET',
        `/api/v2/group-operations/${operationId}`,
      );
      if (data.state !== 'running') return data;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error('Group operation did not finish');
  };
  return {
    port: address.port,
    root,
    store,
    open,
    repo,
    cloak,
    source: first.source,
    git: first.git,
    workspace,
    dashboard,
    repoId,
    id,
    base,
    call,
    settle,
    settleGroup,
  };
}

it('counts changed lines and ignores a trailing newline', () => {
  expect(countLines('a\nb\n', 'a\nc\nd\n')).toEqual({ additions: 2, deletions: 1 });
  expect(countLines('', 'a\n')).toEqual({ additions: 1, deletions: 0 });
  expect(countLines('a\n', '')).toEqual({ additions: 0, deletions: 1 });
  expect(countLines('a\n', 'a\n')).toEqual({ additions: 0, deletions: 0 });
});

it('rejects bad parameters and bodies before they reach the engine', async () => {
  const { call, base, repoId } = await fixture();
  expect((await call('GET', '/api/v2/workspaces/not-a-repo/x')).status).toBe(400);
  expect((await call('GET', `/api/v2/workspaces/${repoId}/unknown`)).status).toBe(404);
  for (const body of [
    {},
    { target: { kind: 'nope' } },
    { target: { kind: 'origin', extra: 1 } },
    { target: { kind: 'new-worktree', branch: '--upload-pack=x' } },
    { target: { kind: 'worktree', path: '' } },
  ])
    expect((await call('POST', `${base}/push`, body)).status).toBe(400);
  expect(
    (await call('POST', `${base}/pull`, { target: { kind: 'commit', ref: '-x' } })).status,
  ).toBe(400);
  expect((await call('GET', `${base}/export/commits?offset=-1`)).status).toBe(400);
  expect((await call('GET', `${base}/export/commits?offset=1.5`)).status).toBe(400);
  expect((await call('GET', `${base}/export/commits?unknown=1`)).status).toBe(400);
  expect((await call('POST', `${base}/export/files`, { commit: 'HEAD' })).status).toBe(400);
  expect((await call('POST', `${base}/open`, { target: 'finder' })).status).toBe(400);
  expect((await call('DELETE', base, { path: '/x' })).status).toBe(400);
  expect((await call('GET', '/api/v2/groups/not-a-uuid')).status).toBe(400);
  expect((await call('GET', '/api/v2/group-operations/not-a-uuid')).status).toBe(400);
});

it('keeps the session token in front of every home route', async () => {
  const { port } = await fixture();
  for (const item of homeRoutes) {
    const path = item.path.replace(/:\w+/g, 'x');
    expect((await fetch(`http://127.0.0.1:${port}${path}`, { method: item.method })).status).toBe(
      401,
    );
  }
});

it('describes pending changes with restored paths, counts, guards and lineage', async () => {
  const { call, base, workspace, source } = await fixture();
  await writeFile(join(workspace, 'Northwind.ts'), 'class Northwind {}\nline 2\nline 3\n');
  await writeFile(join(workspace, 'NorthwindJob.ts'), 'job\n');
  await rm(join(workspace, 'Other.ts'));
  const { status, data } = await call<WorkspaceDetailView>('GET', base);
  expect(status).toBe(200);
  expect(data.pending).toEqual(
    expect.arrayContaining([
      {
        path: 'Northwind.ts',
        restoredPath: 'Acme.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
      },
      {
        path: 'NorthwindJob.ts',
        restoredPath: 'AcmeJob.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
      },
      { path: 'Other.ts', restoredPath: 'Other.ts', status: 'deleted', additions: 0, deletions: 1 },
    ]),
  );
  expect(data.workspace.state).toBe('to-push');
  expect(data.workspace.lineage.repo.path).toBe(source);
  expect(data.workspace.counts).toMatchObject({ modified: 1, added: 1, deleted: 1 });
  expect(data.profiles).toEqual(['sample']);
  expect(data.main?.branch).toBe('main');
  expect(data.worktrees[0]?.path).toBe(source);
  const guards = Object.fromEntries(data.guards.map((guard) => [guard.id, guard]));
  expect(guards.reversal?.state).toBe('ok');
  expect(guards['source-moved']?.state).toBe('ok');
  expect(guards['derived-names']).toMatchObject({
    state: 'warning',
    detail: 'NorthwindJob.ts → AcmeJob.ts',
  });
  expect(guards.exclusions?.state).toBe('ok');
  expect(guards.leaks?.state).toBe('ok');
});

it('flags a real name that reached the cloak, without revealing it in the guard text', async () => {
  const { call, base, workspace } = await fixture();
  await writeFile(join(workspace, 'Other.ts'), 'mentions Acme directly\n');
  const { data } = await call<WorkspaceDetailView>('GET', base);
  const leak = data.guards.find((guard) => guard.id === 'leaks');
  expect(leak).toMatchObject({ state: 'blocked', detail: 'Other.ts' });
  expect(`${leak?.title} ${leak?.detail}`).not.toContain('Acme');
});

const heuristic = (data: WorkspaceDetailView) =>
  data.guards.find((guard) => guard.id === 'leak-heuristics');

it('warns about an unrelated server name, without blocking and with no claim of safety', async () => {
  const { call, base, workspace } = await fixture();
  await writeFile(join(workspace, 'Other.ts'), 'const host = "ch-prod-sql01";\n');
  const { data } = await call<WorkspaceDetailView>('GET', base);
  const guard = heuristic(data);
  expect(guard?.state).toBe('warning');
  expect(guard?.title).toMatch(/heuristic/);
  expect(guard?.findings).toEqual([{ path: 'Other.ts', name: 'ch-prod-sql01', kind: 'server' }]);
  expect(`${guard?.title} ${guard?.detail}`).not.toContain('ch-prod-sql01');
  expect(data.guards.find((item) => item.id === 'leaks')?.state).toBe('ok');
});

it('never calls a quiet scan safe', async () => {
  const { call, base } = await fixture();
  const { data } = await call<WorkspaceDetailView>('GET', base);
  const guard = heuristic(data);
  expect(guard).toMatchObject({ state: 'info', title: expect.stringMatching(/heuristic/i) });
  expect(guard?.detail).toContain('not proof');
  expect(guard?.findings).toBeUndefined();
  const leaks = data.guards.find((item) => item.id === 'leaks');
  expect(leaks?.title).toContain('from the ledger');
  expect(JSON.stringify(data.guards)).not.toMatch(/no real names found in the cloak/i);
});

it('does not flag replaced values or common public names', async () => {
  const { call, base, workspace } = await fixture();
  await writeFile(
    join(workspace, 'Other.ts'),
    'Northwind-prod-sql01 http://localhost:3000 dev@example.com https://registry.npmjs.org/x\n',
  );
  const { data } = await call<WorkspaceDetailView>('GET', base);
  expect(heuristic(data)?.findings).toBeUndefined();
});

it('looks for the source repository identity from its remote and authors', async () => {
  const { call, base, git, source, workspace } = await fixture();
  await git('remote', 'add', 'origin', 'https://token:hunter2@git.contoso.se/fabrikam/thing.git');
  await writeFile(join(source, 'Later.ts'), 'later\n');
  await git('add', '-A');
  await git('-c', 'user.email=dev@adatum-corp.se', '-c', 'user.name=t', 'commit', '-qm', 'later');
  await writeFile(join(workspace, 'Other.ts'), 'FabrikamClient adatum-corp\n');
  const { data } = await call<WorkspaceDetailView>('GET', base);
  expect(heuristic(data)?.findings?.map((finding) => [finding.name, finding.kind])).toEqual([
    ['FabrikamClient', 'identity'],
    ['adatum-corp', 'identity'],
  ]);
  expect(JSON.stringify(data)).not.toContain('hunter2');
});

it('says when the scan stopped at a limit', async () => {
  const { call, base, workspace } = await fixture();
  await writeFile(join(workspace, 'Other.ts'), `${'x\n'.repeat(200_000)}ch-prod-sql01\n`);
  const { data } = await call<WorkspaceDetailView>('GET', base);
  const guard = heuristic(data);
  expect(guard?.findings).toBeUndefined();
  expect(guard?.detail).toContain('partial scan');
  expect(guard?.detail).toContain('not proof');
});

it('keeps findings out of the audit log, agent responses and the cloak workspace', async () => {
  const { call, base, workspace, dashboard } = await fixture();
  const name = 'ch-prod-sql01';
  await writeFile(join(workspace, 'Planted.ts'), `const host = "${name}";\n`);
  const { data } = await call<WorkspaceDetailView>('GET', base);
  expect(JSON.stringify(heuristic(data)?.findings)).toContain(name);

  const audit = await dashboard.sync.audit.list({ limit: 1000 });
  expect(JSON.stringify(audit)).not.toContain(name);

  const token = (await readFile(join(workspace, '.repo-cloak/agent/token'), 'utf8')).trim();
  const doc = await dashboard.agents.authenticate(token);
  if (!doc) throw new Error('Agent token unavailable');
  const responses = [
    await dashboard.agents.agentCall(doc, 'info', {}),
    await dashboard.agents.agentCall(doc, 'probe', { paths: ['Planted.ts', 'Other.ts'] }),
    await dashboard.agents.agentCall(doc, 'requests', {
      clientRequestId: 'leak-guard',
      paths: ['Other.ts'],
      reason: 'Check nothing is passed on.',
    }),
  ];
  expect(JSON.stringify(responses)).not.toContain(name);

  const holders: string[] = [];
  for (const entry of await readdir(workspace, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path, 'utf8')).includes(name)) holders.push(relative(workspace, path));
  }
  expect(holders).toEqual(['Planted.ts']);
});

it('reports source movement as a count of tracked files and blocks on overlap', async () => {
  const { call, base, git, source, workspace } = await fixture();
  await writeFile(join(source, 'Other.ts'), 'moved\n');
  await writeFile(join(source, 'Untracked.ts'), 'not in the cloak\n');
  await git('add', '-A');
  await git(...identity, 'commit', '-qm', 'second');
  const moved = (await call<WorkspaceDetailView>('GET', base)).data;
  expect(moved.sourceMovedFiles).toBe(1);
  expect(moved.workspace.state).toBe('source-moved');
  expect(moved.guards.find((guard) => guard.id === 'source-moved')?.state).toBe('info');
  await writeFile(join(workspace, 'Other.ts'), 'edited too\n');
  const overlap = (await call<WorkspaceDetailView>('GET', base)).data;
  expect(overlap.guards.find((guard) => guard.id === 'source-moved')).toMatchObject({
    state: 'blocked',
    title: '1 file changed on both sides',
  });
  const preview = await call<TargetPreview>('POST', `${base}/push`, {
    target: { kind: 'origin' },
  });
  expect(preview.data.summary.canApply).toBe(false);
  expect(preview.data.summary.conflicts).toEqual(['Other.ts']);
});

it('still describes a workspace whose folder has gone', async () => {
  const { call, base, workspace } = await fixture();
  await rm(workspace, { recursive: true, force: true });
  const { status, data } = await call<WorkspaceDetailView>('GET', base);
  expect(status).toBe(200);
  expect(data.workspace.state).toBe('missing');
  expect(data.pending).toEqual([]);
  expect(data.guards[0]).toMatchObject({ id: 'folder', state: 'blocked' });
});

it('pushes through a preview to the origin worktree and records history', async () => {
  const { call, base, workspace, source, settle } = await fixture();
  await writeFile(join(workspace, 'Northwind.ts'), 'class Northwind { pushed() {} }\n');
  const { status, data } = await call<TargetPreview>('POST', `${base}/push`, {
    target: { kind: 'origin' },
  });
  expect(status).toBe(200);
  expect(data.summary).toMatchObject({ intent: 'restore', writes: ['Acme.ts'], canApply: true });
  expect(data.patch).toBeUndefined();
  expect(await readFile(join(source, 'Acme.ts'), 'utf8')).toContain('line two');
  await call('POST', `/api/v2/operations/${data.operationId}/apply`, {});
  expect((await settle(data.operationId)).state).toBe('completed');
  expect(await readFile(join(source, 'Acme.ts'), 'utf8')).toBe('class Acme { pushed() {} }\n');
  const after = (await call<WorkspaceDetailView>('GET', base)).data;
  expect(after.lastPushAt).not.toBeNull();
  expect(after.pending).toEqual([]);
  expect(after.history[0]).toMatchObject({ op: 'push', outcome: 'ok' });
  expect(after.history.length).toBeLessThanOrEqual(4);
});

it('limits history to the last four events for this workspace', async () => {
  const { call, base, settle } = await fixture();
  for (let run = 0; run < 5; run++) {
    const { data } = await call<TargetPreview>('POST', `${base}/pull`, {
      target: { kind: 'origin' },
    });
    await call('POST', `/api/v2/operations/${data.operationId}/apply`, {});
    await settle(data.operationId);
  }
  const { data } = await call<WorkspaceDetailView>('GET', base);
  expect(data.history).toHaveLength(4);
  expect(data.history.every((event) => event.op === 'pull')).toBe(true);
});

it('targets the main checkout, another worktree and a new worktree', async () => {
  const { call, base, workspace, source, root, git, settle, id } = await fixture();
  await writeFile(join(workspace, 'Northwind.ts'), 'class Northwind { two() {} }\n');
  const other = join(root, 'other-tree');
  await git('worktree', 'add', '-q', '-b', 'other', other);

  const main = await call<TargetPreview>('POST', `${base}/push`, { target: { kind: 'main' } });
  expect(main.data.summary.destination.path).toBe(source);
  await call('DELETE', `/api/v2/operations/${main.data.operationId}`);

  const tree = await call<TargetPreview>('POST', `${base}/push`, {
    target: { kind: 'worktree', path: other },
  });
  expect(tree.data.summary.destination.path).toBe(other);
  await call('POST', `/api/v2/operations/${tree.data.operationId}/apply`, {});
  expect((await settle(tree.data.operationId)).state).toBe('completed');
  expect(await readFile(join(other, 'Acme.ts'), 'utf8')).toContain('two()');
  expect(await readFile(join(source, 'Acme.ts'), 'utf8')).toContain('line two');

  const fresh = await call<TargetPreview>('POST', `${base}/push`, {
    target: { kind: 'new-worktree', branch: `cloak/${id.slice(0, 6)}` },
  });
  expect(fresh.status).toBe(200);
  expect(fresh.data.summary.destination.branch).toBe(`cloak/${id.slice(0, 6)}`);
  await call('DELETE', `/api/v2/operations/${fresh.data.operationId}`);

  const foreign = await call('POST', `${base}/push`, {
    target: { kind: 'worktree', path: join(root, 'cloak-one') },
  });
  expect(foreign.status).toBe(400);
});

it('exports a restored patch and dry-runs without writing or leaving an operation', async () => {
  const { call, base, workspace, source } = await fixture();
  await writeFile(join(workspace, 'Northwind.ts'), 'class Northwind { patched() {} }\nline two\n');
  const before = await readFile(join(source, 'Acme.ts'), 'utf8');
  for (const kind of ['patch', 'dry-run']) {
    const { status, data } = await call<TargetPreview>('POST', `${base}/push`, {
      target: { kind },
    });
    expect(status).toBe(200);
    expect(data.summary.canApply).toBe(false);
    expect(data.patch).toContain('a/Acme.ts');
    expect(data.patch).toContain('+class Acme { patched() {} }');
    expect(data.patch).not.toContain('Northwind');
    const applied = await call('POST', `/api/v2/operations/${data.operationId}/apply`, {});
    expect(applied.status).toBe(410);
  }
  expect(await readFile(join(source, 'Acme.ts'), 'utf8')).toBe(before);
});

it('pulls from origin, main and a commit', async () => {
  const { call, base, git, source, workspace, settle } = await fixture();
  await writeFile(join(source, 'Other.ts'), 'moved\n');
  await writeFile(join(source, 'Third.ts'), 'from the commit\n');
  await git('add', '-A');
  await git(...identity, 'commit', '-qm', 'second');
  const sha = (await git('rev-parse', 'HEAD')).trim();

  const main = await call<TargetPreview>('POST', `${base}/pull`, { target: { kind: 'main' } });
  expect(main.data.summary).toMatchObject({ intent: 'refresh', canApply: true });
  await call('DELETE', `/api/v2/operations/${main.data.operationId}`);

  const commit = await call<TargetPreview>('POST', `${base}/pull`, {
    target: { kind: 'commit', ref: sha },
  });
  expect(commit.data.summary.writes).toContain('Third.ts');
  expect(commit.data.summary.sourceCommit).toBe(sha);
  await call('DELETE', `/api/v2/operations/${commit.data.operationId}`);

  const origin = await call<TargetPreview>('POST', `${base}/pull`, {
    target: { kind: 'origin' },
  });
  await call('POST', `/api/v2/operations/${origin.data.operationId}/apply`, {});
  expect((await settle(origin.data.operationId)).state).toBe('completed');
  expect(await readFile(join(workspace, 'Other.ts'), 'utf8')).toBe('moved\n');
});

it('pulls committed content over a dirty worktree through the route, and rejects an unknown sha', async () => {
  const { call, base, git, source, workspace, settle } = await fixture();
  await writeFile(join(source, 'Other.ts'), 'committed\n');
  await git('add', '-A');
  await git(...identity, 'commit', '-qm', 'second');
  await writeFile(join(source, 'Other.ts'), 'dirty\n');
  const unknown = await call<{ code: string; error: string }>('POST', `${base}/pull`, {
    target: { kind: 'commit', ref: '0123456789012345678901234567890123456789' },
  });
  expect(unknown.status).toBe(400);
  expect(unknown.data.error).toContain('Commit not found');
  const preview = await call<TargetPreview>('POST', `${base}/pull`, {
    target: { kind: 'commit', ref: 'HEAD' },
  });
  await call('POST', `/api/v2/operations/${preview.data.operationId}/apply`, {});
  expect((await settle(preview.data.operationId)).state).toBe('completed');
  expect(await readFile(join(workspace, 'Other.ts'), 'utf8')).toBe('committed\n');
});

it('opens through the desktop adapter and lists its options', async () => {
  const { call, base, open, workspace } = await fixture();
  const desktop = await call<Record<string, { label: string }>>('GET', '/api/v2/desktop');
  expect(desktop.data.folder?.label).toBe('Reveal in Finder');
  expect((await call('POST', `${base}/open`, { target: 'folder' })).data).toEqual({ opened: true });
  expect(open).toHaveBeenCalledWith(workspace, 'folder');
});

it('deletes a workspace only with its exact path and confirmation', async () => {
  const { call, base, workspace } = await fixture();
  expect((await call('DELETE', base, { path: '/elsewhere', confirm: true })).status).toBe(400);
  const { status, data } = await call<{ deleted: string }>('DELETE', base, {
    path: workspace,
    confirm: true,
  });
  expect(status).toBe(200);
  expect(typeof data.deleted).toBe('string');
  expect((await call('GET', base)).status).toBe(404);
});

it('exports commits, files and a cloaked diff', async () => {
  const { call, base, git, source } = await fixture();
  await writeFile(join(source, 'Acme.ts'), 'class Acme { later() {} }\n');
  await git('add', '-A');
  await git(...identity, 'commit', '-qm', 'later');
  const commits = await call<CommitEntry[]>('GET', `${base}/export/commits`);
  expect(commits.data[0]).toMatchObject({ subject: 'later', files: 1 });
  expect(commits.data[0]?.when).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const commit = commits.data[0]?.sha;
  const single = await call<CommitEntry[]>('GET', `${base}/export/commits?ref=HEAD`);
  expect(single.data[0]?.sha).toBe(commit);
  const files = await call<{ files: { path: string; index: number }[] }>(
    'POST',
    `${base}/export/files`,
    { commit },
  );
  expect(files.data.files[0]?.path).toBe('Northwind.ts');
  const diff = await call<{ patch: string }>('POST', `${base}/export/diff`, {
    commit,
    indexes: [0],
  });
  expect(diff.data.patch).toContain('Northwind');
  expect(diff.data.patch).not.toContain('Acme');
});

async function groupFixture() {
  const base = await fixture();
  const second = await base.repo('source-two');
  const secondWorkspace = join(base.root, 'cloak-two');
  const made = await base.cloak(second.source, secondWorkspace);
  await base.dashboard.sync.worktrees(base.repoId);
  const secondRepoId = (await createDashboard(base.store, second.source).context())
    .repoId as string;
  const created = await base.call<GroupDetailView>('POST', '/api/v2/groups', {
    name: 'claims',
    members: [
      { repoId: base.repoId, workspaceId: base.id, worktree: base.source },
      { repoId: secondRepoId, workspaceId: made.workspaceId, worktree: second.source },
    ],
  });
  expect(created.status).toBe(200);
  return { ...base, second, secondWorkspace, secondRepoId, group: created.data };
}

it('describes group members with targets, plans, folder and rules', async () => {
  const { call, group, workspace, source, secondRepoId, second, repoId } = await groupFixture();
  await writeFile(join(workspace, 'Northwind.ts'), 'edited Northwind\n');
  await writeFile(join(second.source, 'Other.ts'), 'moved\n');
  await second.git('add', '-A');
  await second.git(...identity, 'commit', '-qm', 'moved');
  const { data } = await call<GroupDetailView>('GET', `/api/v2/groups/${group.id}`);
  const first = data.members.find((member) => member.repoId === repoId);
  const other = data.members.find((member) => member.repoId === secondRepoId);
  expect(first).toMatchObject({
    folder: 'cloak-one/',
    source: 'source',
    target: { kind: 'origin' },
    toPush: 1,
    sourceMoved: 0,
    plan: 'write 1 file',
    worktree: source,
    tracked: 2,
  });
  expect(other).toMatchObject({ toPush: 0, sourceMoved: 1, plan: 'pull 1 file' });
  expect(data.rules).toEqual({ stopOnGuardFailure: true, sameCommitMessage: true });
  expect(data.folder).toBeNull();
  const list = await call<{ groups: GroupDetailView[] }>('GET', '/api/v2/groups');
  expect(list.data.groups.map((item) => item.id)).toEqual([group.id]);
});

it('bulk pushes every member through the engine batch and lists the run', async () => {
  const { call, group, workspace, secondWorkspace, source, second, settleGroup } =
    await groupFixture();
  await writeFile(join(workspace, 'Northwind.ts'), 'class Northwind { one() {} }\n');
  await writeFile(join(secondWorkspace, 'Northwind.ts'), 'class Northwind { two() {} }\n');
  const preview = await call<TargetPreview>('POST', `/api/v2/groups/${group.id}/bulk`, {
    direction: 'push',
    revision: group.revision,
    stopOnGuardFailure: true,
  });
  expect(preview.status).toBe(200);
  expect(preview.data.summary.writes).toEqual(['Acme.ts', 'Acme.ts']);
  expect(preview.data).not.toHaveProperty('members');
  const applied = await call<GroupOperationView>(
    'POST',
    `/api/v2/group-operations/${preview.data.operationId}/apply`,
    { members: [] },
  );
  expect(applied.status).toBe(200);
  const done = await settleGroup(preview.data.operationId);
  expect(done.state).toBe('completed');
  expect(done.members.map((member) => member.state)).toEqual(['completed', 'completed']);
  expect(await readFile(join(source, 'Acme.ts'), 'utf8')).toContain('one()');
  expect(await readFile(join(second.source, 'Acme.ts'), 'utf8')).toContain('two()');
  const after = await call<GroupDetailView>('GET', `/api/v2/groups/${group.id}`);
  expect(after.data.runs.filter((run) => run.op === 'push')).toHaveLength(2);
});

it('rejects a stale bulk and cancels a prepared one', async () => {
  const { call, group, settleGroup } = await groupFixture();
  const stale = await call('POST', `/api/v2/groups/${group.id}/bulk`, {
    direction: 'pull',
    revision: 'old',
    stopOnGuardFailure: true,
  });
  expect(stale.status).toBe(409);
  const preview = await call<TargetPreview>('POST', `/api/v2/groups/${group.id}/bulk`, {
    direction: 'pull',
    revision: group.revision,
    stopOnGuardFailure: true,
  });
  await call('DELETE', `/api/v2/group-operations/${preview.data.operationId}`);
  expect((await settleGroup(preview.data.operationId)).state).toBe('cancelled');
});

it('answers 409 busy while another holder has the group lock, and the run stays pending', async () => {
  const { call, group, store, settleGroup } = await groupFixture();
  const preview = await call<TargetPreview>('POST', `/api/v2/groups/${group.id}/bulk`, {
    direction: 'pull',
    revision: group.revision,
    stopOnGuardFailure: true,
  });
  const held = await createGroupStore(store).acquire();
  const refused = await call<{ code: string }>(
    'POST',
    `/api/v2/group-operations/${preview.data.operationId}/apply`,
    { members: [] },
  );
  expect(refused.status).toBe(409);
  expect(refused.data.code).toBe('busy');
  await held.release();
  const applied = await call('POST', `/api/v2/group-operations/${preview.data.operationId}/apply`, {
    members: [],
  });
  expect(applied.status).toBe(200);
  expect((await settleGroup(preview.data.operationId)).state).toBe('completed');
});

it('refuses a member outside the group', async () => {
  const { call, group } = await groupFixture();
  const { status } = await call('POST', `/api/v2/groups/${group.id}/bulk`, {
    direction: 'pull',
    revision: group.revision,
    stopOnGuardFailure: true,
    members: ['0123456789abcdef'],
  });
  expect(status).toBe(400);
});

async function conflictedGroup() {
  const context = await groupFixture();
  const { workspace, secondWorkspace, source, git } = context;
  await writeFile(join(workspace, 'Other.ts'), 'edited in the cloak\n');
  await writeFile(join(source, 'Other.ts'), 'edited at the source\n');
  await git('add', '-A');
  await git(...identity, 'commit', '-qm', 'moved');
  await writeFile(join(secondWorkspace, 'Northwind.ts'), 'class Northwind { clean() {} }\n');
  return context;
}

it('stops all members when a guard fails and the rule is on', async () => {
  const { call, group, second } = await conflictedGroup();
  const { data } = await call<TargetPreview>('POST', `/api/v2/groups/${group.id}/bulk`, {
    direction: 'push',
    revision: group.revision,
    stopOnGuardFailure: true,
  });
  expect(data.summary.canApply).toBe(false);
  const refused = await call('POST', `/api/v2/group-operations/${data.operationId}/apply`, {
    members: [],
  });
  expect(refused.status).toBe(409);
  expect(await readFile(join(second.source, 'Acme.ts'), 'utf8')).toContain('line two');
});

it('skips the failing member and pushes the rest when the rule is off', async () => {
  const { call, group, second, source, settleGroup, repoId, secondRepoId } =
    await conflictedGroup();
  const { data } = await call<TargetPreview>('POST', `/api/v2/groups/${group.id}/bulk`, {
    direction: 'push',
    revision: group.revision,
    stopOnGuardFailure: false,
  });
  expect(data.summary.canApply).toBe(true);
  expect(data.summary.writes).toEqual(['Acme.ts']);
  expect(data.summary.warnings.join(' ')).toContain('Skipped source');
  await call('POST', `/api/v2/group-operations/${data.operationId}/apply`, { members: [] });
  const done = await settleGroup(data.operationId);
  expect(done.state).toBe('completed');
  const states = Object.fromEntries(done.members.map((member) => [member.repoId, member.state]));
  expect(states[repoId]).toBe('unattempted');
  expect(states[secondRepoId]).toBe('completed');
  expect(await readFile(join(second.source, 'Acme.ts'), 'utf8')).toContain('clean()');
  expect(await readFile(join(source, 'Other.ts'), 'utf8')).toBe('edited at the source\n');
});

it('runs only the checked members', async () => {
  const { call, group, workspace, secondWorkspace, source, second, settleGroup, secondRepoId } =
    await groupFixture();
  await writeFile(join(workspace, 'Northwind.ts'), 'class Northwind { one() {} }\n');
  await writeFile(join(secondWorkspace, 'Northwind.ts'), 'class Northwind { two() {} }\n');
  const { data } = await call<TargetPreview>('POST', `/api/v2/groups/${group.id}/bulk`, {
    direction: 'push',
    revision: group.revision,
    stopOnGuardFailure: true,
    members: [secondRepoId],
  });
  await call('POST', `/api/v2/group-operations/${data.operationId}/apply`, { members: [] });
  expect((await settleGroup(data.operationId)).state).toBe('completed');
  expect(await readFile(join(second.source, 'Acme.ts'), 'utf8')).toContain('two()');
  expect(await readFile(join(source, 'Acme.ts'), 'utf8')).toContain('line two');
});

it('commits every pushed member with the same message', async () => {
  const { call, group, workspace, secondWorkspace, git, second, settleGroup } =
    await groupFixture();
  await writeFile(join(workspace, 'Northwind.ts'), 'class Northwind { one() {} }\n');
  await writeFile(join(secondWorkspace, 'Northwind.ts'), 'class Northwind { two() {} }\n');
  for (const run of [git, second.git]) {
    await run('config', 'user.email', 't@example.com');
    await run('config', 'user.name', 't');
    await run('config', 'commit.gpgSign', 'false');
  }
  const { data } = await call<TargetPreview>('POST', `/api/v2/groups/${group.id}/bulk`, {
    direction: 'push',
    revision: group.revision,
    stopOnGuardFailure: true,
    commitMessage: 'Export claims',
  });
  await call('POST', `/api/v2/group-operations/${data.operationId}/apply`, { members: [] });
  expect((await settleGroup(data.operationId)).state).toBe('completed');
  for (const run of [git, second.git]) {
    expect((await run('log', '-1', '--format=%s')).trim()).toBe('Export claims');
    expect((await run('status', '--porcelain')).trim()).toBe('');
  }
});

it('retries only the failed member and still commits what it wrote', async () => {
  const { call, group, workspace, secondWorkspace, git, second, settleGroup, secondRepoId } =
    await groupFixture();
  await writeFile(join(workspace, 'Northwind.ts'), 'class Northwind { one() {} }\n');
  await writeFile(join(secondWorkspace, 'Northwind.ts'), 'class Northwind { two() {} }\n');
  for (const run of [git, second.git]) {
    await run('config', 'user.email', 't@example.com');
    await run('config', 'user.name', 't');
    await run('config', 'commit.gpgSign', 'false');
  }
  const indexLock = join(second.source, '.git/index.lock');
  await writeFile(indexLock, '');
  const { data } = await call<TargetPreview>('POST', `/api/v2/groups/${group.id}/bulk`, {
    direction: 'push',
    revision: group.revision,
    stopOnGuardFailure: true,
    commitMessage: 'Export claims',
  });
  await call('POST', `/api/v2/group-operations/${data.operationId}/apply`, { members: [] });
  const failed = await settleGroup(data.operationId);
  expect(failed.state).toBe('failed');
  expect(failed.members.find((member) => member.repoId === secondRepoId)?.state).toBe('failed');
  await rm(indexLock);
  const retried = await call<GroupOperationView>(
    'POST',
    `/api/v2/group-operations/${data.operationId}/retry`,
  );
  expect(retried.data.members.map((member) => member.repoId)).toEqual([secondRepoId]);
  await call('POST', `/api/v2/group-operations/${retried.data.operationId}/apply`, { members: [] });
  expect((await settleGroup(retried.data.operationId)).state).toBe('completed');
  expect((await second.git('log', '-1', '--format=%s')).trim()).toBe('Export claims');
});

it('renames, repoints, joins and deletes groups with revision checks', async () => {
  const context = await groupFixture();
  const { call, group, repoId, id, root, git, secondRepoId } = context;
  const other = join(root, 'alt-tree');
  await git('worktree', 'add', '-q', '-b', 'alt', other);
  const members = group.members.map((member) => ({
    repoId: member.repoId,
    workspaceId: member.workspaceId,
    worktree: member.repoId === repoId ? other : member.worktree,
  }));
  const stale = await call('PUT', `/api/v2/groups/${group.id}`, {
    revision: 'old',
    group: { name: 'renamed', members },
  });
  expect(stale.status).toBe(409);
  const saved = await call<GroupDetailView>('PUT', `/api/v2/groups/${group.id}`, {
    revision: group.revision,
    group: { name: 'renamed', members },
  });
  expect(saved.data.name).toBe('renamed');
  expect(saved.data.members.find((member) => member.repoId === repoId)?.target).toEqual({
    kind: 'worktree',
    path: other,
  });
  const narrowed = await call<GroupDetailView>('PUT', `/api/v2/groups/${group.id}`, {
    revision: saved.data.revision,
    group: { name: 'renamed', members: members.filter((item) => item.repoId === secondRepoId) },
  });
  expect(narrowed.data.members).toHaveLength(1);
  const joined = await call<GroupDetailView>('POST', `/api/v2/groups/${group.id}/members`, {
    revision: narrowed.data.revision,
    member: { repoId, workspaceId: id, worktree: context.source },
  });
  expect(joined.data.members).toHaveLength(2);
  expect((await call('DELETE', `/api/v2/groups/${group.id}`, { revision: 'old' })).status).toBe(
    409,
  );
  expect(
    (await call('DELETE', `/api/v2/groups/${group.id}`, { revision: joined.data.revision })).data,
  ).toEqual({ deleted: group.id });
  expect((await call('GET', `/api/v2/groups/${group.id}`)).status).toBe(404);
});

it('moves members into a shared folder and opens it', async () => {
  const { call, group, open, root } = await groupFixture();
  const moved = await call<GroupDetailView>('PUT', `/api/v2/groups/${group.id}`, {
    revision: group.revision,
    group: {
      name: group.name,
      moveWorkspaces: true,
      folderRoot: join(root, 'shared'),
      members: group.members.map(({ repoId, workspaceId, worktree }) => ({
        repoId,
        workspaceId,
        worktree,
      })),
    },
  });
  expect(moved.status).toBe(200);
  expect(moved.data.folder).toContain(join(root, 'shared'));
  const opened = await call('POST', `/api/v2/groups/${group.id}/open`, { target: 'folder' });
  expect(opened.data).toEqual({ opened: true });
  expect(open).toHaveBeenCalledWith(moved.data.folder, 'folder');
});
