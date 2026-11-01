import { createPublicKey, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { matchesAudit, parseAuditQuery } from '../../src/adapters/server-v2/admin.js';
import { createDashboardServer } from '../../src/adapters/server.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import type { LoadedPolicy } from '../../src/core/policy.js';
import type {
  AgentAccess,
  AgentClientSetup,
  AgentRequest,
  AgentRequestDetail,
  AuditEventView,
  AuditPage,
  AuditVerification,
  DashboardSettings,
  KeyRotationResult,
  KnownRepo,
  RepoDetail,
} from '../../src/web/api/contracts.js';

// Each fixture runs real Git and a real pull, which is slow on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const commit = [
  '-c',
  'user.email=t@example.com',
  '-c',
  'user.name=t',
  '-c',
  'commit.gpgSign=false',
];

async function fixture(policy?: () => Promise<LoadedPolicy>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak admin ')));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, 'source');
  await mkdir(source);
  const store = createStore(join(root, 'store'), policy ? { policy } : {});
  const services = createSyncServices(source, store);
  const git = (...args: string[]) => services.git.runGit(source, args);
  await git('init', '-b', 'main');
  await writeFile(join(source, 'Acme.ts'), 'class Acme {}');
  await writeFile(join(source, 'AcmeExtra.ts'), 'class AcmeExtra {}\n'.repeat(60));
  await writeFile(join(source, 'AcmeDenied.ts'), 'class AcmeDenied {}');
  await git('add', '-A');
  await git(...commit, 'commit', '-qm', 'first');
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  const dashboard = createDashboard(store, source);
  cleanups.push(async () => dashboard.sync.close());
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
    return { status: response.status, body: (await response.json()) as T };
  };
  const { repoId = '' } = await dashboard.context();
  const profile = await dashboard.saveProfile({
    scope: { kind: 'repo', repoId },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'names',
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    },
  });
  const preview = await dashboard.sync.preview({
    intent: 'create',
    repoId,
    worktree: source,
    workspacesRoot: join(root, 'cloaks'),
    name: 'service-cloak',
    profiles: [{ id: profile.id, scope: profile.scope }],
    files: ['Acme.ts'],
  });
  await dashboard.sync.apply(preview.operationId, {});
  const created = await dashboard.sync.wait(preview.operationId);
  if (!created.result) throw new Error(created.error ?? 'Workspace was not created');
  const workspaceId = created.result.workspaceId;
  const path = created.result.workspace;
  const token = (await readFile(join(path, '.repo-cloak/agent/token'), 'utf8')).trim();
  const doc = await dashboard.agents.authenticate(token);
  if (!doc) throw new Error('Agent token unavailable');
  await dashboard.agents.agentCall(doc, 'requests', {
    clientRequestId: 'one',
    paths: ['NorthwindExtra.ts', 'NorthwindDenied.ts'],
    reason: 'Need the extra class.',
  });
  return { root, source, git, store, services, dashboard, call, repoId, workspaceId, path };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const requests = async (f: Fixture) =>
  (await f.call<{ requests: AgentRequest[] }>('GET', '/api/v2/requests')).body.requests;
const requestUrl = (request: AgentRequest) =>
  `/api/v2/requests/${request.workspaceId}/${encodeURIComponent(request.id)}`;
const find = async (f: Fixture, path: string) => {
  const found = (await requests(f)).find((request) => request.path === path);
  if (!found) throw new Error(`No request for ${path}`);
  return found;
};

/* ---------- Known repos ---------- */

it('lists repos with worktree counts and last use, and pins them', async () => {
  const f = await fixture();
  await f.git('worktree', 'add', '-qb', 'feature', join(f.root, 'feature'));
  const { body } = await f.call<{ repos: KnownRepo[] }>('GET', '/api/v2/repos');
  expect(body.repos).toEqual([
    expect.objectContaining({
      id: f.repoId,
      name: 'source',
      missing: false,
      pinned: false,
      workspaceCount: 1,
      worktreeCount: 2,
      lastUsedAt: expect.any(String) as string,
    }),
  ]);
  const pinned = await f.call<RepoDetail>('PUT', `/api/v2/repos/${f.repoId}`, { pinned: true });
  expect(pinned.body.repo.pinned).toBe(true);
  const listed = await f.call<{ repos: KnownRepo[] }>('GET', '/api/v2/repos');
  expect(listed.body.repos[0]?.pinned).toBe(true);
  const unpinned = await f.call<RepoDetail>('PUT', `/api/v2/repos/${f.repoId}`, { pinned: false });
  expect(unpinned.body.repo.pinned).toBe(false);
});

it('reports worktrees with ahead and behind counts and which have a cloak', async () => {
  const f = await fixture();
  const linked = join(f.root, 'feature');
  await f.git('worktree', 'add', '-qb', 'feature', linked);
  await writeFile(join(linked, 'new.ts'), 'export {};');
  await f.services.git.runGit(linked, ['add', '-A']);
  await f.services.git.runGit(linked, [...commit, 'commit', '-qm', 'ahead one']);
  await writeFile(join(f.source, 'main.ts'), 'export {};');
  await f.git('add', 'main.ts');
  await f.git(...commit, 'commit', '-qm', 'main moved one');
  await f.git(...commit, 'commit', '-qm', 'main moved two', '--allow-empty');
  const { body } = await f.call<RepoDetail>('GET', `/api/v2/repos/${f.repoId}`);
  expect(body.worktrees).toEqual([
    {
      path: f.source,
      isMain: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
      workspace: { id: f.workspaceId, name: 'service-cloak' },
    },
    { path: linked, isMain: false, branch: 'feature', ahead: 1, behind: 2, workspace: null },
  ]);
  expect(body.exposure).toEqual({ filesOut: 1, workspaces: 1 });
});

it('saves repo exclusions, reports default profiles and refuses rules it cannot enforce', async () => {
  const f = await fixture();
  const url = `/api/v2/repos/${f.repoId}`;
  const before = await f.call<RepoDetail>('GET', url);
  expect(before.body.rules).toEqual({ defaultProfiles: ['names'], exclude: [], allowedRoots: [] });
  const rules = { defaultProfiles: ['names'], allowedRoots: [] as string[] };
  const saved = await f.call<RepoDetail>('PUT', url, {
    rules: { ...rules, exclude: ['**/PHI/**'] },
  });
  expect(saved.body.rules.exclude).toEqual(['**/PHI/**']);
  const roots = await f.call<{ error: string }>('PUT', url, {
    rules: { ...rules, exclude: [], allowedRoots: ['src/'] },
  });
  expect(roots.status).toBe(501);
  expect(roots.body.error).toMatch(/not enforced/i);
  const profiles = await f.call('PUT', url, {
    rules: { ...rules, exclude: [], defaultProfiles: ['other'] },
  });
  expect(profiles.status).toBe(501);
  expect((await f.call<RepoDetail>('GET', url)).body.rules.exclude).toEqual(['**/PHI/**']);
  const badPattern = await f.call('PUT', url, { rules: { ...rules, exclude: ['../outside'] } });
  expect(badPattern.status).toBe(400);
});

it('adds and forgets repos, and validates ids and bodies', async () => {
  const f = await fixture();
  const other = join(f.root, 'other');
  await mkdir(other);
  await f.services.git.runGit(other, ['init', '-b', 'main']);
  const added = await f.call<KnownRepo>('POST', '/api/v2/repos', { path: other });
  expect(added.body).toMatchObject({ name: 'other', workspaceCount: 0, pinned: false });
  expect((await f.call('POST', '/api/v2/repos', { path: join(f.root, 'nope') })).status).toBe(400);
  expect((await f.call('POST', '/api/v2/repos', { path: other, extra: 1 })).status).toBe(400);
  expect((await f.call('GET', '/api/v2/repos/not-a-repo')).status).toBe(400);
  expect((await f.call('GET', '/api/v2/repos/0000000000000000')).status).toBe(404);
  expect((await f.call('PUT', `/api/v2/repos/${added.body.id}`, { pinned: 'yes' })).status).toBe(
    400,
  );
  const removed = await f.call<{ removed: string }>('DELETE', `/api/v2/repos/${added.body.id}`);
  expect(removed.body).toEqual({ removed: added.body.id });
  const list = await f.call<{ repos: KnownRepo[] }>('GET', '/api/v2/repos');
  expect(list.body.repos.map((repo) => repo.id)).toEqual([f.repoId]);
});

it('keeps a repo whose folder has gone visible so it can be forgotten', async () => {
  const f = await fixture();
  await rm(f.source, { recursive: true, force: true });
  const { body } = await f.call<RepoDetail>('GET', `/api/v2/repos/${f.repoId}`);
  expect(body.repo).toMatchObject({ missing: true, worktreeCount: 0 });
  expect(body.worktrees).toEqual([]);
});

/* ---------- Agent requests ---------- */

it('lists one inbox entry per file with cloaked paths only', async () => {
  const f = await fixture();
  const list = await requests(f);
  expect(list.map((request) => [request.path, request.state, request.reason]).sort()).toEqual([
    ['NorthwindDenied.ts', 'waiting', 'Need the extra class.'],
    ['NorthwindExtra.ts', 'waiting', 'Need the extra class.'],
  ]);
  expect(list[0]).toMatchObject({
    repoId: f.repoId,
    workspaceId: f.workspaceId,
    workspaceName: 'service-cloak',
  });
  expect(JSON.stringify(list)).not.toContain('AcmeExtra');
  const access = await f.call<AgentAccess>('GET', `/api/v2/agents/${f.repoId}/${f.workspaceId}`);
  expect(JSON.stringify(access.body)).not.toContain('Acme');
});

it('gives a policy check and the cloaked text the agent would receive, cut to length', async () => {
  const f = await fixture();
  const request = await find(f, 'NorthwindExtra.ts');
  const { body } = await f.call<AgentRequestDetail>('GET', requestUrl(request));
  expect(body.state).toBe('waiting');
  expect(body.checks.map((check) => [check.id, check.state])).toEqual(
    expect.arrayContaining([
      ['exclusions', 'ok'],
      ['recheck', 'ok'],
      ['names', 'ok'],
    ]),
  );
  expect(body.preview).toContain('class NorthwindExtra {}');
  expect(body.preview).not.toContain('Acme');
  expect(body.preview).toContain('more lines');
  expect(body.preview?.split('\n')).toHaveLength(41);
  // Looking at a request must not use up the pending preview slots.
  for (let i = 0; i < 9; i++) expect((await f.call('GET', requestUrl(request))).status).toBe(200);
});

it('marks excluded files blocked, shows no preview and refuses to approve them', async () => {
  const f = await fixture();
  await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['AcmeDenied.ts'] });
  const request = await find(f, 'NorthwindDenied.ts');
  expect(request.state).toBe('blocked');
  const detail = await f.call<AgentRequestDetail>('GET', requestUrl(request));
  expect(detail.body.preview).toBeNull();
  expect(detail.body.checks).toEqual([
    expect.objectContaining({ id: 'exclusions', state: 'blocked' }),
  ]);
  const refused = await f.call('POST', requestUrl(request), { decision: 'approve', mode: 'full' });
  expect(refused.status).toBe(400);
  await expect(readFile(join(f.path, 'NorthwindDenied.ts'))).rejects.toThrow();
});

it('approves one file, which lands in the cloak, leaving the rest waiting', async () => {
  const f = await fixture();
  const request = await find(f, 'NorthwindExtra.ts');
  const { status, body } = await f.call<AgentRequestDetail>('POST', requestUrl(request), {
    decision: 'approve',
    mode: 'full',
  });
  expect(status).toBe(200);
  expect(body.state).toBe('pulled');
  expect(await readFile(join(f.path, 'NorthwindExtra.ts'), 'utf8')).toContain('NorthwindExtra');
  expect((await find(f, 'NorthwindDenied.ts')).state).toBe('waiting');
  const audit = await f.call<AuditPage>('GET', '/api/v2/audit?q=op:approve');
  expect(audit.body.events[0]?.files).toEqual([{ path: 'NorthwindExtra.ts' }]);
});

it('denies a file without pulling it and records the decision', async () => {
  const f = await fixture();
  const request = await find(f, 'NorthwindDenied.ts');
  const { body } = await f.call<AgentRequestDetail>('POST', requestUrl(request), {
    decision: 'deny',
  });
  expect(body.state).toBe('denied');
  await expect(readFile(join(f.path, 'NorthwindDenied.ts'))).rejects.toThrow();
  const audit = await f.call<AuditPage>('GET', '/api/v2/audit?q=op:deny');
  expect(audit.body.events).toHaveLength(1);
});

it('fails closed on signatures-only and auto-approve instead of sending the file', async () => {
  const f = await fixture();
  const request = await find(f, 'NorthwindExtra.ts');
  for (const body of [
    { decision: 'approve', mode: 'signatures' },
    { decision: 'auto-approve', pattern: 'Northwind*.ts' },
  ]) {
    const result = await f.call<{ error: string }>('POST', requestUrl(request), body);
    expect(result.status).toBe(501);
    expect(result.body.error).toMatch(/not supported/i);
  }
  await expect(readFile(join(f.path, 'NorthwindExtra.ts'))).rejects.toThrow();
  expect((await find(f, 'NorthwindExtra.ts')).state).toBe('waiting');
});

it('validates request ids and decisions', async () => {
  const f = await fixture();
  const request = await find(f, 'NorthwindExtra.ts');
  const url = requestUrl(request);
  expect((await f.call('POST', url, { decision: 'maybe' })).status).toBe(400);
  expect((await f.call('POST', url, { decision: 'deny', extra: 1 })).status).toBe(400);
  expect((await f.call('GET', `/api/v2/requests/${f.workspaceId}/nonsense`)).status).toBe(400);
  expect(
    (await f.call('GET', `/api/v2/requests/bad%20id/${encodeURIComponent(request.id)}`)).status,
  ).toBe(400);
  const missing = encodeURIComponent(`00000000-0000-4000-8000-000000000000:${request.path}`);
  expect((await f.call('GET', `/api/v2/requests/${f.workspaceId}/${missing}`)).status).toBe(404);
});

it('turns agent access off and on and exposes the MCP client setup', async () => {
  const f = await fixture();
  const url = `/api/v2/agents/${f.repoId}/${f.workspaceId}`;
  const off = await f.call<AgentAccess>('PUT', url, { enabled: false });
  expect(off.body).toMatchObject({ enabled: false, guidance: true });
  const detail = await f.call<AgentRequestDetail>(
    'GET',
    requestUrl(await find(f, 'NorthwindExtra.ts')),
  );
  expect(detail.body.checks).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'recheck', state: 'blocked' })]),
  );
  expect((await f.call<AgentAccess>('PUT', url, { enabled: true })).body.enabled).toBe(true);
  expect((await f.call('PUT', url, { enabled: 'yes' })).status).toBe(400);
  const setup = await f.call<AgentClientSetup>('GET', `${url}/mcp`);
  expect(setup.body.name).toMatch(/^repo-cloak-/);
  expect(JSON.parse(setup.body.claude)).toHaveProperty('mcpServers');
  expect((await f.call('POST', `${url}/mcp/other`, { confirm: true })).status).toBe(400);
  expect((await f.call('POST', `${url}/mcp/codex`, {})).status).toBe(400);
  const installed = await f.call<{ status: string }>('POST', `${url}/mcp/codex`, { confirm: true });
  expect(installed.body.status).toBe('installed');
});

/* ---------- History ---------- */

const event = (over: Partial<AuditEventView>): AuditEventView => ({
  seq: 1,
  at: '2026-11-01T10:00:00.000Z',
  who: 'sam',
  op: 'pull',
  outcome: 'ok',
  workspace: { id: 'w1', name: 'acme-care-api' },
  files: [{ path: 'src/a.ts' }],
  profiles: [],
  keyId: null,
  detail: 'from main',
  hash: 'h',
  prevHash: 'p',
  ...over,
});

it('parses the filter syntax', () => {
  const now = Date.parse('2026-11-08T10:00:00.000Z');
  expect(parseAuditQuery('op:push ws:Acme who:sam file:a.ts since:7d main', now)).toEqual({
    ops: ['push'],
    workspace: 'acme',
    who: 'sam',
    file: 'a.ts',
    since: Date.parse('2026-11-01T10:00:00.000Z'),
    words: ['main'],
  });
  expect(parseAuditQuery('op:deny', now).ops).toEqual(['agent-deny']);
  expect(parseAuditQuery('op:key', now).ops).toEqual(['key-rotate', 'key-migrate']);
  expect(parseAuditQuery('since:2026-01-02', now).since).toBe(Date.parse('2026-01-02'));
  expect(() => parseAuditQuery('op:nope', now)).toThrow(/op: use one of/);
  expect(() => parseAuditQuery('since:soon', now)).toThrow(/since:/);
});

it('matches events against every part of a filter', () => {
  const now = Date.parse('2026-11-02T10:00:00.000Z');
  const yes = (query: string) => matchesAudit(event({}), parseAuditQuery(query, now));
  for (const query of ['', 'op:pull', 'ws:care', 'who:sam', 'file:src/a', 'since:2d', 'main'])
    expect(yes(query), query).toBe(true);
  for (const query of ['op:push', 'ws:other', 'who:kim', 'file:b.ts', 'since:1h', 'nothing'])
    expect(yes(query), query).toBe(false);
});

it('pages the audit log newest first and applies filters server side', async () => {
  const f = await fixture();
  await f.call('PUT', '/api/v2/settings', { autoLockMinutes: 15 });
  await f.call('PUT', '/api/v2/settings', { autoLockMinutes: 30 });
  await f.call('PUT', '/api/v2/settings', { autoLockMinutes: 45 });
  const all = await f.call<AuditPage>('GET', '/api/v2/audit');
  expect(all.body.total).toBe(4);
  expect(all.body.events.map((item) => item.op)).toEqual([
    'settings',
    'settings',
    'settings',
    'create',
  ]);
  expect(all.body.events[3]).toMatchObject({
    workspace: { id: f.workspaceId, name: 'service-cloak' },
  });
  expect(all.body.events[3]?.files).toEqual([
    expect.objectContaining({ path: 'Northwind.ts', hash: expect.stringMatching(/^sha256-/) }),
  ]);
  const first = await f.call<AuditPage>('GET', '/api/v2/audit?q=op:settings&limit=2');
  expect(first.body).toMatchObject({ total: 3 });
  expect(first.body.events).toHaveLength(2);
  expect(first.body.nextCursor).toBe(first.body.events[1]?.seq);
  const second = await f.call<AuditPage>(
    'GET',
    `/api/v2/audit?q=op:settings&limit=2&cursor=${first.body.nextCursor}`,
  );
  expect(second.body.events).toHaveLength(1);
  expect(second.body.nextCursor).toBeNull();
  for (const query of ['cursor=abc', 'limit=0', 'limit=9999', 'limit=1.5', 'other=1', 'q=op:nope'])
    expect((await f.call('GET', `/api/v2/audit?${query}`)).status, query).toBe(400);
});

it('verifies the chain and reports the first broken link', async () => {
  const f = await fixture();
  await f.call('PUT', '/api/v2/settings', { autoLockMinutes: 15 });
  const good = await f.call<AuditVerification>('POST', '/api/v2/audit/verify');
  expect(good.body).toMatchObject({ ok: true, count: 2 });
  const log = join(f.root, 'store', 'audit', 'log.jsonl');
  const lines = (await readFile(log, 'utf8')).split('\n');
  const line = JSON.parse(lines[0] ?? '') as { seq: number; sealed: unknown };
  lines[0] = JSON.stringify({ ...line, sealed: 'tampered' });
  await writeFile(log, lines.join('\n'));
  const bad = await f.call<AuditVerification>('POST', '/api/v2/audit/verify');
  expect(bad.body).toMatchObject({ ok: false, firstBroken: { line: 1 } });
});

it('signs an export that verifies, detects edits and leaves out real source names', async () => {
  const f = await fixture();
  await writeFile(join(f.path, 'Northwind.ts'), 'class Northwind { edited = true }');
  const preview = await f.dashboard.sync.preview({
    intent: 'restore',
    repoId: f.repoId,
    workspaceId: f.workspaceId,
    worktree: f.source,
  });
  await f.dashboard.sync.apply(preview.operationId, {});
  expect((await f.dashboard.sync.wait(preview.operationId)).state).toBe('completed');
  const pushes = await f.call<AuditPage>('GET', '/api/v2/audit?q=op:push');
  expect(pushes.body.events[0]?.files[0]?.path).toBe('Acme.ts');

  const { body } = await f.call<{ jsonl: string; signature: string; publicKey: string }>(
    'POST',
    '/api/v2/audit/export',
  );
  const key = createPublicKey(body.publicKey);
  const signature = Buffer.from(body.signature, 'base64');
  expect(verify(null, Buffer.from(body.jsonl), key, signature)).toBe(true);
  expect(verify(null, Buffer.from(`${body.jsonl}x`), key, signature)).toBe(false);
  const lines = body.jsonl
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as AuditEventView);
  expect(lines[0]).toMatchObject({ kind: 'repo-cloak-audit-export', verification: { ok: true } });
  expect(lines.slice(1).map((line) => line.op)).toEqual(['create', 'push']);
  expect(body.jsonl).not.toContain('Acme');
  expect(lines[2]?.files[0]?.path).toBe('[source path omitted]');
  expect(lines[2]?.hash).toBe(pushes.body.events[0]?.hash);
});

/* ---------- Settings ---------- */

it('reads and saves general and security settings and audits field names only', async () => {
  const f = await fixture();
  const before = await f.call<DashboardSettings>('GET', '/api/v2/settings');
  expect(before.body).toMatchObject({
    postCreateCommands: [],
    security: {
      keyStorage: 'auto',
      autoLockMinutes: null,
      allowExclusionOverride: true,
      locked: [],
      policy: { status: 'none', path: null, signed: false },
    },
  });
  const root = join(f.root, 'cloak-root');
  const { body } = await f.call<DashboardSettings>('PUT', '/api/v2/settings', {
    workspacesRoot: root,
    postCreateCommands: ['echo secret-command'],
    autoLockMinutes: 15,
    auditRetentionDays: 365,
    allowExclusionOverride: false,
    keyStorage: 'file',
  });
  expect(body).toMatchObject({
    workspacesRoot: root,
    postCreateCommands: ['echo secret-command'],
    security: {
      autoLockMinutes: 15,
      auditRetentionDays: 365,
      allowExclusionOverride: false,
      keyStorage: 'file',
    },
  });
  const cleared = await f.call<DashboardSettings>('PUT', '/api/v2/settings', {
    autoLockMinutes: null,
  });
  expect(cleared.body.security.autoLockMinutes).toBeNull();
  const audit = await f.call<AuditPage>('GET', '/api/v2/audit?q=op:settings');
  expect(JSON.stringify(audit.body)).not.toContain('secret-command');
});

it('rejects a bad settings body and changes nothing when any part is refused', async () => {
  const f = await fixture();
  for (const body of [
    { unknown: true },
    { autoLockMinutes: -1 },
    { autoLockMinutes: 1.5 },
    { keyStorage: 'cloud' },
    { postCreateCommands: ['ok', ''] },
    { workspacesRoot: '' },
  ])
    expect((await f.call('PUT', '/api/v2/settings', body)).status, JSON.stringify(body)).toBe(400);
  const refused = await f.call('PUT', '/api/v2/settings', {
    workspacesRoot: f.source, // Inside a Git repository.
    autoLockMinutes: 15,
  });
  expect(refused.status).toBe(400);
  const after = await f.call<DashboardSettings>('GET', '/api/v2/settings');
  expect(after.body.security.autoLockMinutes).toBeNull();
});

it('reports policy-locked fields and rejects changing them', async () => {
  const f = await fixture(() =>
    Promise.resolve({
      status: 'active',
      path: '/etc/repo-cloak/policy.json',
      signed: true,
      userWritable: false,
      policy: {
        schemaVersion: 1,
        lockedExclusions: ['**/*.pem'],
        auditRetentionDays: 365,
        allowExclusionOverride: false,
      },
    }),
  );
  const { body } = await f.call<DashboardSettings>('GET', '/api/v2/settings');
  expect(body.security).toMatchObject({
    lockedExclusions: ['**/*.pem'],
    auditRetentionDays: 365,
    allowExclusionOverride: false,
    policy: { status: 'active', path: '/etc/repo-cloak/policy.json', signed: true },
  });
  expect(body.security.locked).toEqual(
    expect.arrayContaining(['lockedExclusions', 'auditRetentionDays', 'allowExclusionOverride']),
  );
  const denied = await f.call<{ error: string }>('PUT', '/api/v2/settings', {
    auditRetentionDays: 30,
  });
  expect(denied.status).toBe(400);
  expect(denied.body.error).toMatch(/locked by machine policy/);
  expect((await f.call('PUT', '/api/v2/settings', { autoLockMinutes: 15 })).status).toBe(200);
  // A locked exclusion shows on the repo but is never stored as the repo's own.
  const repo = await f.call<RepoDetail>('GET', `/api/v2/repos/${f.repoId}`);
  expect(repo.body.rules.exclude).toContain('**/*.pem');
});

it('rotates the key and keeps the store readable, and validates migration', async () => {
  const f = await fixture();
  const { body } = await f.call<KeyRotationResult>('POST', '/api/v2/settings/key/rotate');
  expect(body.keyId).not.toBe(body.previousKeyId);
  expect(body.pending).toEqual([]);
  expect((await requests(f)).length).toBe(2);
  const verified = await f.call<AuditVerification>('POST', '/api/v2/audit/verify');
  expect(verified.body.ok).toBe(true);
  const audit = await f.call<AuditPage>('GET', '/api/v2/audit?q=op:key');
  expect(audit.body.events[0]?.op).toBe('key-rotate');
  expect((await f.call('POST', '/api/v2/settings/key/migrate', { target: 'cloud' })).status).toBe(
    400,
  );
  // A store outside the default root is file-only, so tests can never reach a real keychain.
  expect(
    (await f.call('POST', '/api/v2/settings/key/migrate', { target: 'keychain' })).status,
  ).toBe(400);
});

it('keeps token and origin checks in front of every admin route', async () => {
  const f = await fixture();
  const ok = await f.call('GET', '/api/v2/repos');
  expect(ok.status).toBe(200);
  const address = (await f.call<{ port: number }>('GET', '/api/v2/session')).body.port;
  for (const path of [
    '/api/v2/repos',
    '/api/v2/requests',
    '/api/v2/audit',
    '/api/v2/settings',
    `/api/v2/agents/${f.repoId}/${f.workspaceId}`,
  ]) {
    expect((await fetch(`http://127.0.0.1:${address}${path}`)).status).toBe(401);
    const foreign = await fetch(`http://127.0.0.1:${address}${path}`, {
      headers: { Authorization: 'Bearer test-token', Origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
  }
});
