import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
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

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
/** Call from afterEach in the test file. */
export async function cleanupFixtures() {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}
export const secret = `ghp_${'a1b2c3'.repeat(6)}`;

export async function fixture(initGit = true) {
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
  let dashboard = createDashboard(store, source);
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
  let base = '';
  const listen = async () => {
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
    base = `http://127.0.0.1:${address.port}/api/v2/push/${repoId}/${encodeURIComponent(workspaceId)}`;
  };
  await listen();
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
    get dashboard() {
      return dashboard;
    },
    repoId,
    workspaceId,
    get base() {
      return base;
    },
    /** A new process would start from what is on disk: a fresh store, dashboard and server. */
    async restart() {
      dashboard = createDashboard(createStore(join(root, 'store')), source);
      await listen();
    },
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
export const editedLines = (lines: string[], at: number, text: string) =>
  `${lines.map((line, index) => (index === at ? text : line)).join('\n')}\n`.replaceAll(
    'Acme',
    'Northwind',
  );
