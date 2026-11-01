import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { expandPostCreateCommand, newRoutes } from '../../src/adapters/server-v2/new.js';
import { createDashboardServer } from '../../src/adapters/server.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import type {
  CommitEntry,
  NewCloakContext,
  NewCloakReview,
  OperationPreview,
  OperationState,
  SetupState,
  TreeNode,
  UncommittedFile,
} from '../../src/web/api/contracts.js';

// These spawn many Git processes and a shared machine can make that slow.
vi.setConfig({ testTimeout: 60_000 });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A synthetic repository: never the real store, keychain or a real repo. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak new ')));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, 'contoso-health-api');
  await mkdir(join(source, 'src', 'Contoso'), { recursive: true });
  await mkdir(join(source, 'db'));
  const store = createStore(join(root, 'store'));
  const services = createSyncServices(source, store);
  const git = (...args: string[]) => services.git.runGit(source, args);
  const commit = (message: string) =>
    git(
      '-c',
      'commit.gpgSign=false',
      '-c',
      `core.hooksPath=${join(root, 'no-hooks')}`,
      '-c',
      'user.name=Fixture Author',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      message,
    );
  await git('init', '-b', 'main');
  await writeFile(join(source, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(source, 'ignored.txt'), 'secret local notes\n');
  await writeFile(join(source, 'package-lock.json'), '{}\n');
  await writeFile(join(source, 'src/Contoso/Service.ts'), 'class Contoso {}\nconst a = 1;\n');
  await writeFile(join(source, 'src/Contoso/Other.ts'), 'export const other = "Contoso";\n');
  await writeFile(join(source, 'db/ContosoDbContext.cs'), 'class ContosoDbContext {}\n');
  await git('add', '-A');
  await commit('Initial import');
  await writeFile(join(source, 'src/Contoso/Later.ts'), 'export const later = 1;\n');
  await git('add', '-A');
  await commit('claims: add later export');
  const head = (await git('rev-parse', 'HEAD')).trim();
  const dashboard = createDashboard(store, source);
  const context = await dashboard.context();
  const repoId = context.repoId ?? '';
  const saved = await dashboard.saveProfile({
    scope: { kind: 'global' },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'contoso',
      rules: [{ id: 'brand', type: 'literal', match: 'Contoso', replace: 'Acme' }],
      exclude: ['*DbContext.cs'],
    },
  });
  await services.store.saveConfig({
    kind: 'config',
    schemaVersion: 1,
    initGit: false,
    workspacesRoot: join(root, 'cloaks'),
  });
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
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: 'Bearer test-token' };
  const raw = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await raw(path, method, body);
    const value = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(`${response.status}: ${value.error}`);
    return value;
  }
  const place = new URLSearchParams({ repo: repoId, worktree: source }).toString();
  const selection = (overrides: Record<string, unknown> = {}) => ({
    repoId,
    worktree: source,
    uncommitted: [],
    commits: [],
    paths: ['src/Contoso/Service.ts'],
    profiles: [{ id: saved.id, scope: { kind: 'global' } }],
    ...overrides,
  });
  const create = (overrides: Record<string, unknown> = {}) => ({
    ...selection(overrides),
    name: 'acme-care',
    destination: join(root, 'cloaks', 'acme-care'),
    postCreateCommands: [],
    ignoreLeftovers: true,
    ...overrides,
  });
  async function apply(operationId: string) {
    let state = await call<OperationState>(`/api/v2/operations/${operationId}/apply`, 'POST', {
      profiles: true,
    });
    while (state.state === 'running')
      state = await call<OperationState>(`/api/v2/operations/${operationId}`);
    return state;
  }
  return {
    root,
    source,
    git,
    commit,
    head,
    dashboard,
    services,
    repoId,
    profileId: saved.id,
    raw,
    call,
    place,
    selection,
    create,
    apply,
  };
}

it('keeps token and origin checks in front of every route of this package', async () => {
  const { raw, place } = await fixture();
  const base = new URL((await raw('/api/v2/session')).url).origin;
  for (const path of [
    `/api/v2/new/context?${place}`,
    `/api/v2/new/changes?${place}`,
    `/api/v2/new/tree?${place}`,
    '/api/v2/folders',
    '/api/v2/setup',
    '/api/v2/worktrees/0000000000000000',
  ]) {
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    const foreign = await fetch(`${base}${path}`, {
      headers: { Authorization: 'Bearer test-token', Origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
  }
});

it('detects the worktree, branch, ahead count and existing cloaks', async () => {
  const { call, place, root, git, repoId, create, apply } = await fixture();
  const main = await call<NewCloakContext>(`/api/v2/new/context?${place}`);
  expect(main).toMatchObject({
    repoId,
    branch: 'main',
    ahead: 0,
    existing: [],
    destinationLocked: true,
    destinationRoot: join(root, 'cloaks'),
    groups: [],
  });
  const tree = join(root, 'claims-tree');
  await git('worktree', 'add', '-b', 'feat/claims', tree);
  await writeFile(join(tree, 'extra.ts'), 'export const extra = 1;\n');
  await createSyncServices(tree, createStore(join(root, 'unused'))).git.runGit(tree, ['add', '-A']);
  await git(
    '-C',
    tree,
    '-c',
    'commit.gpgSign=false',
    '-c',
    'user.name=F',
    '-c',
    'user.email=f@example.test',
    'commit',
    '-qm',
    'ahead by one',
  );
  const ahead = await call<NewCloakContext>(
    `/api/v2/new/context?${new URLSearchParams({ repo: repoId, worktree: tree })}`,
  );
  expect(ahead).toMatchObject({ branch: 'feat/claims', ahead: 1 });

  const preview = await call<OperationPreview>('/api/v2/new/create', 'POST', create());
  expect((await apply(preview.operationId)).state).toBe('completed');
  const after = await call<NewCloakContext>(`/api/v2/new/context?${place}`);
  expect(after.existing.map((item) => item.name)).toEqual(['acme-care']);
});

it('rejects a worktree that does not belong to the repository', async () => {
  const { raw, root, repoId, selection } = await fixture();
  const other = await mkdtemp(join(root, 'other-'));
  const query = new URLSearchParams({ repo: repoId, worktree: other });
  expect((await raw(`/api/v2/new/context?${query}`)).status).toBe(400);
  expect((await raw(`/api/v2/new/tree?${query}`)).status).toBe(400);
  expect((await raw('/api/v2/new/review', 'POST', selection({ worktree: other }))).status).toBe(
    400,
  );
});

it('lists uncommitted files from git status, with their status and exclusion', async () => {
  const { call, place, source, git } = await fixture();
  await writeFile(join(source, 'src/Contoso/Service.ts'), 'class Contoso { edited = 1 }\n');
  await writeFile(join(source, 'new-file.ts'), 'export {};\n');
  await writeFile(join(source, 'package-lock.json'), '{"edited":true}\n');
  await rm(join(source, 'src/Contoso/Other.ts'));
  await git('mv', 'src/Contoso/Later.ts', 'src/Contoso/Renamed.ts');
  const { uncommitted } = await call<{ uncommitted: UncommittedFile[] }>(
    `/api/v2/new/changes?${place}`,
  );
  expect(uncommitted).toEqual(
    expect.arrayContaining([
      { path: 'src/Contoso/Service.ts', status: 'M', excluded: false },
      { path: 'new-file.ts', status: '?', excluded: false },
      { path: 'src/Contoso/Other.ts', status: 'D', excluded: false },
      { path: 'src/Contoso/Renamed.ts', status: 'R', excluded: false },
      { path: 'package-lock.json', status: 'M', excluded: true },
    ]),
  );
  expect(uncommitted.map((file) => file.path)).not.toContain('ignored.txt');
});

it('pages commits and searches older ones by sha, message and author', async () => {
  const { call, place, head, git, commit, source } = await fixture();
  for (let index = 0; index < 22; index++) {
    await writeFile(join(source, 'counter.ts'), `export const n = ${index};\n`);
    await git('add', '-A');
    await commit(`chore: bump ${index}`);
  }
  type Page = { commits: CommitEntry[]; nextOffset: number | null };
  const first = await call<Page>(`/api/v2/new/changes?${place}`);
  expect(first.commits).toHaveLength(20);
  expect(first.commits[0]).toMatchObject({ subject: 'chore: bump 21', files: 1 });
  expect(Number.isNaN(Date.parse(first.commits[0]?.when ?? ''))).toBe(false);
  expect(first.nextOffset).toBe(20);
  const second = await call<Page>(`/api/v2/new/changes?${place}&offset=20`);
  expect(second.commits.at(-1)?.subject).toBe('Initial import');
  expect(second.nextOffset).toBeNull();
  const search = async (text: string) =>
    (await call<Page>(`/api/v2/new/changes?${place}&search=${encodeURIComponent(text)}`)).commits;
  expect((await search('later export')).map((item) => item.sha)).toEqual([head]);
  expect((await search(head.slice(0, 8))).map((item) => item.sha)).toEqual([head]);
  expect((await search('Fixture Auth')).length).toBe(20);
  expect(await search('--all')).toEqual([]);
});

it('rejects malformed queries instead of guessing', async () => {
  const { raw, place } = await fixture();
  for (const path of [
    `/api/v2/new/changes?${place}&offset=-1`,
    `/api/v2/new/changes?${place}&offset=1.5`,
    `/api/v2/new/changes?${place}&offset=abc`,
    `/api/v2/new/changes?${place}&extra=1`,
    `/api/v2/new/tree?${place}&directory=../..`,
    `/api/v2/new/tree?${place}&directory=.git`,
    '/api/v2/new/context?repo=nope&worktree=/x',
    '/api/v2/folders?offset=-1',
    '/api/v2/folders?offset=1e3',
    '/api/v2/setup?repo=nope',
  ])
    expect((await raw(path)).status, path).toBe(400);
});

it('shows excluded tree nodes with their rule, and hides ignored files', async () => {
  const { call, dashboard, repoId, place } = await fixture();
  await dashboard.sync.saveExclusions(repoId, { patterns: ['db/'] });
  const level = async (directory?: string) =>
    (
      await call<{ nodes: TreeNode[] }>(
        `/api/v2/new/tree?${place}${directory ? `&directory=${directory}` : ''}`,
      )
    ).nodes;
  const top = await level();
  expect(top).toEqual(
    expect.arrayContaining([
      { path: 'db', kind: 'folder', files: 0, excludedBy: 'db/' },
      { path: 'src', kind: 'folder', files: 3, excludedBy: null },
      { path: 'package-lock.json', kind: 'file', files: 0, excludedBy: 'global' },
    ]),
  );
  expect(top.map((node) => node.path)).not.toContain('ignored.txt');
  expect(await level('src')).toEqual([
    { path: 'src/Contoso', kind: 'folder', files: 3, excludedBy: null },
  ]);
  expect((await level('src/Contoso')).map((node) => node.path)).toEqual([
    'src/Contoso/Later.ts',
    'src/Contoso/Other.ts',
    'src/Contoso/Service.ts',
  ]);
});

it('reviews files, lines, held-back rules, hits, path preview and the CLI line', async () => {
  const { call, selection } = await fixture();
  const review = await call<NewCloakReview>(
    '/api/v2/new/review',
    'POST',
    selection({ paths: ['src', 'db'], uncommitted: ['package-lock.json'] }),
  );
  expect(review.files).toBe(3);
  expect(review.lines).toBe(7);
  expect(review.heldBack).toEqual([
    { path: 'db/ContosoDbContext.cs', rule: '*DbContext.cs' },
    { path: 'package-lock.json', rule: 'global' },
  ]);
  expect(review.replacements).toEqual([{ find: 'Contoso', replace: 'Acme', hits: 5 }]);
  expect(review.pathPreview[0]).toEqual({
    source: 'contoso-health-api',
    cloaked: 'acme-health-api',
  });
  expect(review.pathPreview).toContainEqual({
    source: 'src/Contoso/Service.ts',
    cloaked: 'src/Acme/Service.ts',
  });
  expect(review.cli).toBe('repo-cloak pull --working --paths src,db -p contoso');
});

it('merges and dedupes the three sources', async () => {
  const { call, selection, head, source } = await fixture();
  await writeFile(join(source, 'src/Contoso/Later.ts'), 'export const later = 2;\n');
  const review = await call<NewCloakReview>(
    '/api/v2/new/review',
    'POST',
    selection({
      uncommitted: ['src/Contoso/Later.ts'],
      commits: [head],
      paths: ['src/Contoso/Later.ts'],
    }),
  );
  expect(review.files).toBe(1);
});

it('never reviews or pulls a gitignored file through a folder pick', async () => {
  const { call, selection, create, apply, root, source } = await fixture();
  await mkdir(join(source, 'conf'));
  await writeFile(join(source, 'conf/.gitignore'), 'local.env\n');
  await writeFile(join(source, 'conf/local.env'), 'TOKEN=real\n');
  await writeFile(join(source, 'conf/app.ts'), 'export {};\n');
  const review = await call<NewCloakReview>(
    '/api/v2/new/review',
    'POST',
    selection({ paths: ['conf'] }),
  );
  expect(review.files).toBe(2);
  const preview = await call<OperationPreview>(
    '/api/v2/new/create',
    'POST',
    create({ paths: ['conf'] }),
  );
  expect(preview.summary.writes).not.toContain('conf/local.env');
  expect((await apply(preview.operationId)).state).toBe('completed');
  await expect(readFile(join(root, 'cloaks/acme-care/conf/local.env'))).rejects.toThrow();
});

it('does not echo secret values into the review', async () => {
  const { call, selection, dashboard, source } = await fixture();
  const value = 'AKIAIOSFODNN7EXAMPLE';
  await writeFile(join(source, 'creds.ts'), `export const key = "${value}";\n`);
  const saved = await dashboard.saveProfile({
    scope: { kind: 'global' },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'secrets',
      rules: [{ id: 'aws', type: 'secret', detector: 'aws-access-key' }],
    },
  });
  const review = await call<NewCloakReview>(
    '/api/v2/new/review',
    'POST',
    selection({
      paths: ['creds.ts'],
      profiles: [{ id: saved.id, scope: { kind: 'global' } }],
    }),
  );
  expect(review.replacements).toEqual([
    { find: 'secret: aws-access-key', replace: 'REDACTED', hits: 1 },
  ]);
  expect(JSON.stringify(review)).not.toContain(value);
});

it('warns about leftover real names, and create is blocked until they are ignored', async () => {
  const { call, raw, selection, create, apply, source, root } = await fixture();
  await writeFile(join(source, 'notes.ts'), 'const host = "health-prod-sql01";\n');
  const review = await call<NewCloakReview>(
    '/api/v2/new/review',
    'POST',
    selection({ paths: ['notes.ts'] }),
  );
  expect(review.leftovers).toEqual([{ path: 'notes.ts', name: 'health-prod-sql01' }]);
  const blocked = await raw(
    '/api/v2/new/create',
    'POST',
    create({ paths: ['notes.ts'], ignoreLeftovers: false }),
  );
  expect(blocked.status).toBe(409);
  expect(((await blocked.json()) as { error: string }).error).toMatch(/1 real names have no rule/);
  await expect(readFile(join(root, 'cloaks/acme-care/notes.ts'))).rejects.toThrow();
  const preview = await call<OperationPreview>(
    '/api/v2/new/create',
    'POST',
    create({ paths: ['notes.ts'], ignoreLeftovers: true }),
  );
  expect((await apply(preview.operationId)).state).toBe('completed');
  expect(await readFile(join(root, 'cloaks/acme-care/notes.ts'), 'utf8')).toContain('health-prod');
});

it('flags a near miss the token boundary left unreplaced, but not an excepted word', async () => {
  const { call, selection, dashboard, source } = await fixture();
  await writeFile(join(source, 'near.ts'), 'const a = "Globexian"; const b = "Globex Inc";\n');
  const saved = await dashboard.saveProfile({
    scope: { kind: 'global' },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'globex',
      rules: [
        {
          id: 'g',
          type: 'literal',
          match: 'Globex',
          replace: 'Initech',
          except: ['Globex Inc'],
        },
      ],
    },
  });
  const review = await call<NewCloakReview>(
    '/api/v2/new/review',
    'POST',
    selection({
      paths: ['near.ts'],
      profiles: [{ id: saved.id, scope: { kind: 'global' } }],
    }),
  );
  expect(review.leftovers).toEqual([{ path: 'near.ts', name: 'Globexian' }]);
});

it('creates through the shared operation flow and restores nothing into source', async () => {
  const { call, create, apply, root, source } = await fixture();
  const preview = await call<OperationPreview>('/api/v2/new/create', 'POST', create());
  expect(preview.summary).toMatchObject({ intent: 'create', canApply: true });
  expect(preview.summary.writes).toContain('src/Acme/Service.ts');
  const before = await readFile(join(source, 'src/Contoso/Service.ts'), 'utf8');
  const state = await apply(preview.operationId);
  expect(state.state).toBe('completed');
  expect(await readFile(join(root, 'cloaks/acme-care/src/Acme/Service.ts'), 'utf8')).toContain(
    'class Acme',
  );
  expect(await readFile(join(source, 'src/Contoso/Service.ts'), 'utf8')).toBe(before);
});

it('requires a profile and a selection, and rejects a stray destination', async () => {
  const { raw, create, root } = await fixture();
  const status = async (overrides: Record<string, unknown>) => {
    const response = await raw('/api/v2/new/create', 'POST', create(overrides));
    return [response.status, ((await response.json()) as { error: string }).error];
  };
  expect(await status({ profiles: [] })).toEqual([400, 'Select at least one profile']);
  expect(await status({ paths: [] })).toEqual([400, 'No selected files remain after exclusions']);
  expect(await status({ name: 'other', destination: join(root, 'elsewhere', 'other') })).toEqual([
    400,
    'The destination folder is fixed in Settings',
  ]);
  expect(await status({ destination: join(root, 'cloaks', 'different') })).toEqual([
    400,
    'The destination folder must end with the cloak name',
  ]);
  const bad = await raw('/api/v2/new/create', 'POST', create({ surprise: true }));
  expect(bad.status).toBe(400);
  const traversal = await raw('/api/v2/new/review', 'POST', create({ paths: ['../outside'] }));
  expect(traversal.status).toBe(400);
});

it('uses an exact destination when Settings has no root', async () => {
  const { call, create, apply, services, root } = await fixture();
  const config = await services.store.readConfig();
  const { workspacesRoot, ...rest } = config;
  void workspacesRoot;
  await services.store.saveConfig(rest);
  const destination = join(root, 'chosen', 'picked');
  const preview = await call<OperationPreview>(
    '/api/v2/new/create',
    'POST',
    create({ name: 'picked', destination }),
  );
  expect(preview.summary.destination.path).toBe(destination);
  expect((await apply(preview.operationId)).state).toBe('completed');
});

it('validates the chosen group but leaves joining to the screen after creation', async () => {
  const { call, raw, create, dashboard, repoId, source, apply } = await fixture();
  const missing = await raw(
    '/api/v2/new/create',
    'POST',
    create({ groupId: '00000000-0000-4000-8000-000000000000' }),
  );
  expect(missing.status).toBe(400);
  const first = await call<OperationPreview>(
    '/api/v2/new/create',
    'POST',
    create({ name: 'first', destination: join(source, '..', 'cloaks', 'first') }),
  );
  const done = await apply(first.operationId);
  const group = await dashboard.groups.save({
    name: 'claims',
    members: [
      {
        repoId,
        workspaceId: done.result?.workspaceId ?? '',
        worktree: source,
      },
    ],
  });
  const context = await call<NewCloakContext>(
    `/api/v2/new/context?${new URLSearchParams({ repo: repoId, worktree: source })}`,
  );
  expect(context.groups).toEqual([{ id: group.id, name: 'claims', workspaceCount: 1 }]);
  const preview = await call<OperationPreview>(
    '/api/v2/new/create',
    'POST',
    create({ groupId: group.id, postCreateCommands: ['echo {group}'] }),
  );
  expect(preview.summary.postCreateCommands).toEqual(["echo 'claims'"]);
  const state = await apply(preview.operationId);
  expect(state.state).toBe('completed');
  expect((await dashboard.groups.list())[0]?.members).toHaveLength(1);
});

it('expands post-create variables with shell quoting, so a value cannot run', async () => {
  expect(expandPostCreateCommand('code {dest} {nope}', { dest: '/tmp/a b' })).toBe(
    "code '/tmp/a b' {nope}",
  );
  expect(expandPostCreateCommand('git checkout {branch}', { branch: '$(touch pwned)' })).toBe(
    "git checkout '$(touch pwned)'",
  );
  expect(expandPostCreateCommand('echo {name}', { name: "it's" })).toBe(`echo 'it'\\''s'`);
  expect(expandPostCreateCommand('echo {group}', {})).toBe("echo ''");
});

it('runs post-create commands in the cloak folder with every variable', async () => {
  const { call, create, apply, root, source, head, git } = await fixture();
  await git('checkout', '-q', '-b', 'feat/$(touch${IFS}pwned)');
  const preview = await call<OperationPreview>(
    '/api/v2/new/create',
    'POST',
    create({
      postCreateCommands: [
        'printf "%s\\n" {dest} {source} {branch} {name} {group} {sha} > values.txt',
      ],
    }),
  );
  expect((await apply(preview.operationId)).state).toBe('completed');
  const cloak = join(root, 'cloaks', 'acme-care');
  expect((await readFile(join(cloak, 'values.txt'), 'utf8')).split('\n')).toEqual([
    cloak,
    source,
    'feat/$(touch${IFS}pwned)',
    'acme-care',
    '',
    head,
    '',
  ]);
  await expect(readFile(join(cloak, 'pwned'))).rejects.toThrow();
  await expect(readFile(join(source, 'values.txt'))).rejects.toThrow();
});

it('adds to an existing cloak with its recorded profiles when that is the destination', async () => {
  const { call, create, apply, root } = await fixture();
  const first = await call<OperationPreview>('/api/v2/new/create', 'POST', create());
  await apply(first.operationId);
  const cloak = join(root, 'cloaks', 'acme-care');
  const preview = await call<OperationPreview>(
    '/api/v2/new/create',
    'POST',
    create({ paths: ['src/Contoso/Other.ts'], profiles: [], postCreateCommands: ['touch nope'] }),
  );
  expect(preview.summary).toMatchObject({ intent: 'refresh', postCreateCommands: [] });
  const state = await apply(preview.operationId);
  expect(state.state).toBe('completed');
  expect(await readFile(join(cloak, 'src/Acme/Other.ts'), 'utf8')).toContain('Acme');
  expect(await readFile(join(cloak, 'src/Acme/Service.ts'), 'utf8')).toContain('Acme');
  await expect(readFile(join(cloak, 'nope'))).rejects.toThrow();
});

it('lists worktrees and folders, whole-number offset only', async () => {
  const { call, repoId, source, root } = await fixture();
  const { worktrees } = await call<{ worktrees: { path: string }[] }>(
    `/api/v2/worktrees/${repoId}`,
  );
  expect(worktrees.map((tree) => tree.path)).toEqual([source]);
  for (let index = 0; index < 105; index++)
    await mkdir(join(root, `folder-${String(index).padStart(3, '0')}`));
  const query = new URLSearchParams({ path: root });
  const page = await call<{
    path: string;
    folders: { name: string; path: string }[];
    next: number | null;
    parent?: string;
  }>(`/api/v2/folders?${query}`);
  expect(page.path).toBe(root);
  expect(page.folders).toHaveLength(100);
  expect(page.next).toBe(100);
  expect(page).not.toHaveProperty('parent');
  const rest = await call<{ folders: unknown[]; next: number | null }>(
    `/api/v2/folders?${query}&offset=100`,
  );
  expect(rest.next).toBeNull();
  expect(rest.folders.length).toBeGreaterThan(0);
});

it('reports first-run state with presets on by default and names from the repository', async () => {
  const { call, repoId } = await fixture();
  const state = await call<SetupState>(`/api/v2/setup?repo=${repoId}`);
  expect(state.key).toEqual({ exists: true, storage: 'file' });
  expect(state.profileCount).toBe(1);
  expect(state.exclusionPresets.map((preset) => [preset.id, preset.enabled])).toEqual([
    ['schemas', true],
    ['lockfiles', true],
    ['env', true],
    ['keys', true],
  ]);
  expect(state.suggestedNames).toEqual(['Contoso', 'Health', 'ContosoHealth']);
  const none = await call<SetupState>('/api/v2/setup');
  expect(none.suggestedNames).toEqual([]);
});

it('saves the cloak root and rejects one inside a repository', async () => {
  const { call, raw, root, source } = await fixture();
  const next = join(root, 'my-cloaks');
  const state = await call<SetupState>('/api/v2/setup', 'PUT', { workspacesRoot: next });
  expect(state.workspacesRoot).toBe(next);
  const inside = await raw('/api/v2/setup', 'PUT', { workspacesRoot: join(source, 'cloaks') });
  expect(inside.status).toBe(400);
  expect((await raw('/api/v2/setup', 'PUT', { presets: ['made-up'] })).status).toBe(400);
  expect((await raw('/api/v2/setup', 'PUT', { surprise: 1 })).status).toBe(400);
});

it('enforces saved presets on every new cloak, whichever profiles are chosen', async () => {
  const { call, selection, place, source, dashboard } = await fixture();
  await writeFile(join(source, 'local.env'), 'x\n');
  await writeFile(join(source, '.env'), 'TOKEN=real\n');
  await writeFile(join(source, 'server.pem'), 'pem\n');
  const state = await call<SetupState>('/api/v2/setup', 'PUT', { presets: ['env', 'keys'] });
  expect(state.exclusionPresets.filter((preset) => preset.enabled).map((p) => p.id)).toEqual([
    'env',
    'keys',
  ]);
  expect(state.profileCount).toBe(1);
  const review = await call<NewCloakReview>(
    '/api/v2/new/review',
    'POST',
    selection({ uncommitted: ['.env', 'server.pem'], paths: ['src/Contoso/Service.ts'] }),
  );
  expect(review.files).toBe(1);
  expect(review.heldBack).toEqual([
    { path: '.env', rule: '.env' },
    { path: 'server.pem', rule: '*.pem' },
  ]);
  const { nodes } = await call<{ nodes: TreeNode[] }>(`/api/v2/new/tree?${place}`);
  expect(nodes.find((node) => node.path === 'server.pem')?.excludedBy).toBe('*.pem');
  const again = await call<SetupState>('/api/v2/setup', 'PUT', { presets: [] });
  expect(again.exclusionPresets.every((preset) => !preset.enabled)).toBe(true);
  const profiles = await dashboard.profiles();
  expect(profiles.filter((saved) => saved.profile.name === 'Never pull')).toHaveLength(1);
  const audit = await dashboard.sync.audit.list({ limit: 50 });
  expect(JSON.stringify(audit)).toContain('never-pull presets');
});

it('reading first-run state creates no key; saving the presets creates it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak fresh ')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dashboard = createDashboard(createStore(join(root, 'store')), root);
  const handler = (key: string) => {
    const found = newRoutes.find((item) => `${item.method} ${item.path}` === key);
    if (!found) throw new Error(`No route ${key}`);
    return (body?: unknown) =>
      found.handler({
        dashboard,
        session: { activity() {}, revoke() {} },
        port: 1,
        params: {},
        query: new URLSearchParams(),
        body: () => Promise.resolve(body),
      }) as Promise<SetupState>;
  };
  const first = await handler('GET /api/v2/setup')();
  expect(first.key).toEqual({ exists: false, storage: null });
  expect(first.workspacesRoot).toBeNull();
  expect((await handler('GET /api/v2/setup')()).key.exists).toBe(false);
  const saved = await handler('PUT /api/v2/setup')({ presets: ['env'] });
  expect(saved.key).toEqual({ exists: true, storage: 'file' });
});

it('serves the profile list until 40-profiles registers its own', async () => {
  const { call, profileId } = await fixture();
  const { profiles } = await call<{ profiles: unknown[] }>('/api/v2/profiles');
  expect(profiles).toEqual([
    {
      id: profileId,
      name: 'contoso',
      scope: { kind: 'global' },
      ruleCount: 1,
      exclusionCount: 1,
    },
  ]);
});

it('blocks review when machine policy is invalid', async () => {
  const { raw, selection, dashboard } = await fixture();
  const security = dashboard.settings.security;
  dashboard.settings.security = async () => ({
    ...(await security()),
    policy: { status: 'invalid', path: '/x', signed: false, message: 'bad' },
  });
  const response = await raw('/api/v2/new/review', 'POST', selection());
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toMatch(/policy is invalid/);
});
