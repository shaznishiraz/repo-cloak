import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { stripAgentGuidance } from '../../src/core/agent-guidance.js';
import { createDashboardServer } from '../../src/adapters/server.js';
import { agentDocument } from '../../src/core/agent-requests.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak agent ')));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
  const source = join(root, 'source');
  await mkdir(source);
  const store = createStore(join(root, 'store'));
  const services = createSyncServices(source, store);
  await services.git.runGit(source, ['init', '-b', 'main']);
  await writeFile(join(source, 'Acme.ts'), 'class Acme {}');
  await writeFile(join(source, 'AGENTS.md'), '# Acme project\nKeep user instructions.\n');
  await writeFile(join(source, 'AcmeContext.ts'), 'class AcmeContext {}');
  await writeFile(join(source, 'more.ts'), 'export const more = true;');
  await writeFile(join(source, 'schema.graphql'), 'private schema');
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  const dashboard = createDashboard(store, source);
  cleanups.push(async () => dashboard.sync.close());
  const { repoId = '' } = await dashboard.context();
  const profile = await dashboard.saveProfile({
    scope: { kind: 'repo', repoId },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'names',
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
      exclude: ['*.graphql', 'Acme-private.ts'],
    },
  });
  const globalProfile = await dashboard.saveProfile({
    scope: { kind: 'global' },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'global exclusions',
      rules: [],
      include: ['*-global.ts', 'Acme-private.ts'],
      exclude: ['private-global.ts'],
    },
  });
  const input = {
    intent: 'create',
    repoId,
    worktree: source,
    workspacesRoot: join(root, 'cloaks'),
    name: 'service-cloak',
    profiles: [profile, globalProfile].map(({ id, scope }) => ({ id, scope })),
    files: ['Acme.ts', 'AGENTS.md'],
  };
  const preview = await dashboard.sync.preview(input);
  await dashboard.sync.apply(preview.operationId, {});
  const created = await dashboard.sync.wait(preview.operationId);
  if (!created.result) throw new Error(created.error ?? 'Workspace was not created');
  const workspaceId = created.result.workspaceId;
  const path = created.result.workspace;
  const token = (await readFile(join(path, '.repo-cloak/agent/token'), 'utf8')).trim();
  const doc = await dashboard.agents.authenticate(token);
  if (!doc) throw new Error('Agent token unavailable');
  return {
    root,
    source,
    store,
    services,
    dashboard,
    repoId,
    workspaceId,
    path,
    token,
    doc,
    input,
    profile,
    globalProfile,
  };
}

it('inherits only selected global/repository profiles and repository exclusions without request rules', async () => {
  const f = await fixture();
  await f.dashboard.saveProfile({
    scope: { kind: 'global' },
    profile: {
      kind: 'profile',
      schemaVersion: 1,
      name: 'unselected',
      rules: [],
      exclude: ['more.ts'],
    },
  });
  await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['repository-private.ts'] });
  // Excluded paths give the same answer whether or not the source file exists.
  const paths = [
    'schema.graphql',
    'missing.graphql',
    'Northwind-private.ts',
    'private-global.ts',
    'repository-private.ts',
    'more.ts',
  ];
  expect(await f.dashboard.agents.agentCall(f.doc, 'probe', { paths })).toEqual({
    results: Object.fromEntries(
      paths.map((path) => [path, path === 'more.ts' ? 'available' : 'not_allowed']),
    ),
  });
  expect(await f.dashboard.agents.info(f.repoId, f.workspaceId)).not.toHaveProperty('policy');
  await expect(
    f.dashboard.agents.configure(f.repoId, f.workspaceId, {
      enabled: true,
      policy: { exclude: ['more.ts'] },
    }),
  ).rejects.toThrow();
});

it('discards legacy request-only exclusions instead of retaining a hidden policy', async () => {
  const f = await fixture();
  const legacy = agentDocument.parse({
    ...f.doc,
    policy: { exclude: ['more.ts'], maxFileBytes: 1 },
  });
  expect(legacy).not.toHaveProperty('policy');
  expect(await f.dashboard.agents.agentCall(legacy, 'probe', { paths: ['more.ts'] })).toEqual({
    results: { 'more.ts': 'available' },
  });
  await writeFile(join(f.source, 'schema.prisma'), 'ordinary project schema');
  expect(await f.dashboard.agents.agentCall(legacy, 'probe', { paths: ['schema.prisma'] })).toEqual(
    {
      results: { 'schema.prisma': 'available' },
    },
  );
  await writeFile(join(f.source, 'oversized.ts'), Buffer.alloc(1024 * 1024 + 1, 'a'));
  expect(await f.dashboard.agents.agentCall(legacy, 'probe', { paths: ['oversized.ts'] })).toEqual({
    results: { 'oversized.ts': 'not_allowed' },
  });
});

it.each(['repository', 'profile', 'globalProfile'] as const)(
  'marks queued files ignored using current %s exclusions and restores their eligibility',
  async (scope) => {
    const f = await fixture();
    const request = (await f.dashboard.agents.agentCall(f.doc, 'requests', {
      clientRequestId: 'ignored-review',
      paths: ['NorthwindContext.ts', 'more.ts'],
      reason: 'Need context',
    })) as { id: string };
    const setExclusions = async (patterns: string[]) => {
      if (scope === 'repository') await f.dashboard.sync.saveExclusions(f.repoId, { patterns });
      else {
        const profile = f[scope];
        await f.dashboard.saveProfile({
          ...profile,
          profile: { ...profile.profile, exclude: patterns },
        });
      }
    };
    for (const pattern of ['AcmeContext.ts', 'NorthwindContext.ts']) {
      await setExclusions([pattern]);
      const info = await f.dashboard.agents.info(f.repoId, f.workspaceId);
      expect(info.requests.find((item) => item.id === request.id)?.files).toEqual([
        expect.objectContaining({ path: 'NorthwindContext.ts', state: 'pending', excluded: true }),
        expect.objectContaining({ path: 'more.ts', state: 'pending', excluded: false }),
      ]);
      await expect(
        f.dashboard.agents.preview(f.repoId, f.workspaceId, request.id, {
          paths: ['NorthwindContext.ts'],
        }),
      ).rejects.toThrow(/exclusions changed/);
    }
    if (scope === 'repository') {
      const preview = await f.dashboard.agents.preview(f.repoId, f.workspaceId, request.id, {
        paths: ['more.ts'],
      });
      f.dashboard.sync.operations.cancel(preview.operationId);
    }
    await setExclusions([]);
    const info = await f.dashboard.agents.info(f.repoId, f.workspaceId);
    expect(info.requests[0]?.files.every((file) => !file.excluded)).toBe(true);
  },
);

it.each(['profile', 'globalProfile'] as const)(
  'rechecks changed selected %s exclusions before queueing and approval',
  async (key) => {
    const f = await fixture();
    const request = (await f.dashboard.agents.agentCall(f.doc, 'requests', {
      clientRequestId: 'profile-change',
      paths: ['more.ts'],
      reason: 'Need types',
    })) as { id: string };
    const preview = await f.dashboard.agents.preview(f.repoId, f.workspaceId, request.id, {
      paths: ['more.ts'],
    });
    const profile = f[key];
    await f.dashboard.saveProfile({
      ...profile,
      profile: { ...profile.profile, exclude: [...(profile.profile.exclude ?? []), 'more.ts'] },
    });
    expect(
      await f.dashboard.agents.agentCall(f.doc, 'requests', {
        clientRequestId: 'after-change',
        paths: ['more.ts'],
        reason: 'Need types',
      }),
    ).toMatchObject({ id: null, results: { 'more.ts': 'not_allowed' }, files: [] });
    await expect(
      f.dashboard.agents.preview(f.repoId, f.workspaceId, request.id, { paths: ['more.ts'] }),
    ).rejects.toThrow(/changed/);
    await f.dashboard.agents.apply(f.repoId, f.workspaceId, preview.operationId);
    expect((await f.dashboard.sync.wait(preview.operationId)).state).toBe('failed');
    await expect(readFile(join(f.path, 'more.ts'))).rejects.toThrow();
  },
);

it('names workspaces, injects preserved agent guidance and supports multiple workspaces per source', async () => {
  const f = await fixture();
  expect(f.path).toBe(join(f.root, 'cloaks', 'service-cloak'));
  expect(stripAgentGuidance(await readFile(join(f.path, 'AGENTS.md'), 'utf8'))).toBe(
    '# Northwind project\nKeep user instructions.\n',
  );
  expect(await readFile(join(f.path, 'CLAUDE.md'), 'utf8')).toContain('repo-cloak workspace');
  expect(await readFile(join(f.path, '.repo-cloak/agent/SKILL.md'), 'utf8')).toContain(
    'name: repo-cloak',
  );
  await expect(f.dashboard.sync.preview({ ...f.input, name: '../bad' })).rejects.toThrow();
  const other = await f.dashboard.sync.preview({ ...f.input, name: 'another-cloak' });
  await f.dashboard.sync.apply(other.operationId, {});
  expect((await f.dashboard.sync.wait(other.operationId)).state).toBe('completed');
  expect((await f.dashboard.overview())[0]?.workspaces).toHaveLength(2);
  await mkdir(join(f.path, '.codex'));
  await writeFile(join(f.path, '.codex/config.toml'), 'private_client_setting = true');
  await writeFile(
    join(f.path, 'AGENTS.md'),
    (await readFile(join(f.path, 'AGENTS.md'), 'utf8')).replace(
      'Keep user instructions.',
      'Keep edited instructions.',
    ),
  );
  const push = await f.dashboard.sync.preview({
    intent: 'restore',
    repoId: f.repoId,
    workspaceId: f.workspaceId,
    worktree: f.source,
  });
  await f.dashboard.sync.apply(push.operationId, {});
  expect((await f.dashboard.sync.wait(push.operationId)).state).toBe('completed');
  expect(await readFile(join(f.source, 'AGENTS.md'), 'utf8')).toBe(
    '# Acme project\nKeep edited instructions.\n',
  );
  await expect(readFile(join(f.source, 'CLAUDE.md'))).rejects.toThrow();
  await expect(readFile(join(f.source, '.codex/config.toml'))).rejects.toThrow();
});

it('probes without source disclosure and queues idempotently until the owner pulls an exact subset', async () => {
  const f = await fixture();
  const probe = await f.dashboard.agents.agentCall(f.doc, 'probe', {
    paths: [
      'NorthwindContext.ts',
      join(f.path, 'more.ts'),
      'schema.graphql',
      'missing.graphql',
      'absent.ts',
      '../outside',
    ],
  });
  expect(probe).toEqual({
    results: {
      'NorthwindContext.ts': 'available',
      [join(f.path, 'more.ts')]: 'available',
      'schema.graphql': 'not_allowed',
      'missing.graphql': 'not_allowed',
      'absent.ts': 'unavailable',
      '../outside': 'unavailable',
    },
  });
  const payload = {
    clientRequestId: 'context-1',
    paths: ['NorthwindContext.ts', 'more.ts', 'schema.graphql'],
    reason: 'Need the context types',
  };
  const request = (await f.dashboard.agents.agentCall(f.doc, 'requests', payload)) as {
    id: string;
  };
  expect(
    ((await f.dashboard.agents.agentCall(f.doc, 'requests', payload)) as { id: string }).id,
  ).toBe(request.id);
  await expect(
    f.dashboard.agents.agentCall(f.doc, 'requests', { ...payload, reason: 'different' }),
  ).rejects.toThrow(/key/);
  await expect(readFile(join(f.path, 'NorthwindContext.ts'))).rejects.toThrow();
  expect(
    await readFile(join(f.store.root, 'agents', `${f.workspaceId}.json`), 'utf8'),
  ).not.toContain('AcmeContext');
  await writeFile(join(f.path, 'Northwind.ts'), 'class Northwind { keep = true }');
  const preview = await f.dashboard.agents.preview(f.repoId, f.workspaceId, request.id, {
    paths: ['NorthwindContext.ts'],
  });
  expect(preview.writes).toEqual(['NorthwindContext.ts']);
  await expect(f.dashboard.sync.apply(preview.operationId, {})).rejects.toThrow(/request review/);
  await f.dashboard.agents.apply(f.repoId, f.workspaceId, preview.operationId);
  expect((await f.dashboard.sync.wait(preview.operationId)).state).toBe('completed');
  expect(await readFile(join(f.path, 'NorthwindContext.ts'), 'utf8')).toBe(
    'class NorthwindContext {}',
  );
  expect(await readFile(join(f.path, 'Northwind.ts'), 'utf8')).toContain('keep = true');
  await expect(readFile(join(f.path, 'more.ts'))).rejects.toThrow();
  const status = await f.dashboard.agents.agentCall(f.doc, request.id, {});
  expect(status).toEqual({
    id: request.id,
    files: [
      { path: 'NorthwindContext.ts', state: 'pulled' },
      { path: 'more.ts', state: 'pending' },
    ],
  });
  expect(JSON.stringify(status)).not.toContain('Acme');
  const restored = createDashboard(f.store, f.path);
  cleanups.push(async () => restored.sync.close());
  expect(await restored.agents.agentCall(f.doc, request.id, {})).toEqual(status);
  await writeFile(join(f.path, 'NorthwindContext.ts'), 'class NorthwindContext { edit = true }');
  const push = await f.dashboard.sync.preview({
    intent: 'restore',
    repoId: f.repoId,
    workspaceId: f.workspaceId,
    worktree: f.source,
  });
  await f.dashboard.sync.apply(push.operationId, {});
  expect((await f.dashboard.sync.wait(push.operationId)).state).toBe('completed');
  expect(await readFile(join(f.source, 'AcmeContext.ts'), 'utf8')).toContain(
    'class AcmeContext { edit = true }',
  );
});

it('blocks changed repository exclusions, stale bytes, binary disguises and revoked credentials', async () => {
  const f = await fixture();
  const request = (await f.dashboard.agents.agentCall(f.doc, 'requests', {
    clientRequestId: 'stale',
    paths: ['more.ts'],
    reason: 'Need types',
  })) as { id: string };
  const preview = await f.dashboard.agents.preview(f.repoId, f.workspaceId, request.id, {
    paths: ['more.ts'],
  });
  await writeFile(join(f.source, 'more.ts'), 'changed after review');
  await f.dashboard.agents.apply(f.repoId, f.workspaceId, preview.operationId);
  expect((await f.dashboard.sync.wait(preview.operationId)).state).toBe('failed');
  await expect(readFile(join(f.path, 'more.ts'))).rejects.toThrow();
  const retry = await f.dashboard.agents.preview(f.repoId, f.workspaceId, request.id, {
    paths: ['more.ts'],
  });
  await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['more.ts'] });
  await f.dashboard.agents.apply(f.repoId, f.workspaceId, retry.operationId);
  expect((await f.dashboard.sync.wait(retry.operationId)).state).toBe('failed');
  await expect(readFile(join(f.path, 'more.ts'))).rejects.toThrow();
  await writeFile(join(f.source, 'binary.ts'), Buffer.from([0, 1, 2, 3]));
  const current = await f.dashboard.agents.authenticate(f.token);
  if (!current) throw new Error('Missing scoped credential');
  const binary = (await f.dashboard.agents.agentCall(current, 'requests', {
    clientRequestId: 'binary',
    paths: ['binary.ts'],
    reason: 'Need binary',
  })) as { id: string };
  await expect(
    f.dashboard.agents.preview(f.repoId, f.workspaceId, binary.id, { paths: ['binary.ts'] }),
  ).rejects.toThrow(/text/);
  await f.dashboard.agents.configure(f.repoId, f.workspaceId, { enabled: false });
  expect(await f.dashboard.agents.authenticate(f.token)).toBeUndefined();
  await f.dashboard.deleteWorkspace(f.repoId, f.workspaceId, { path: f.path, confirm: true });
  await expect(readFile(join(f.store.root, 'agents', `${f.workspaceId}.json`))).rejects.toThrow();
  expect(await readFile(join(f.source, 'Acme.ts'), 'utf8')).toBe('class Acme {}');
});

it('separates scoped HTTP credentials from all owner endpoints and redacts lookup errors', async () => {
  const f = await fixture();
  const server = createDashboardServer(f.dashboard, 'owner-secret');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, token = f.token, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await call('/agent/v1/info', 'owner-secret')).status).toBe(401);
  for (const path of [
    '/api/profiles',
    '/api/settings',
    '/api/repos',
    `/api/workspaces/${f.repoId}/${f.workspaceId}/agent`,
  ])
    expect((await call(path)).status).toBe(401);
  expect((await call('/api/sync/preview', f.token, 'POST', f.input)).status).toBe(401);
  expect(
    (
      await call(`/api/workspaces/${f.repoId}/${f.workspaceId}/agent/mcp/codex`, f.token, 'POST', {
        confirm: true,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(base + '/agent/v1/info', {
        headers: { Authorization: `Bearer ${f.token}`, Origin: base },
      })
    ).status,
  ).toBe(403);
  const probe = await call('/agent/v1/probe', f.token, 'POST', {
    paths: ['NorthwindContext.ts', '../../private', 'schema.graphql'],
  });
  expect(probe.status).toBe(200);
  const result = await probe.text();
  expect(result).toContain('available');
  expect(result).not.toContain(f.source);
  expect(result).not.toContain('Acme');
  expect(
    (
      await call('/agent/v1/probe', f.token, 'POST', {
        paths: ['schema.graphql'],
        includeExcluded: true,
      })
    ).status,
  ).toBe(400);
  const error = await (
    await call('/agent/v1/requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  ).text();
  expect(error).not.toContain(f.store.root);
  const other = await f.dashboard.sync.preview({ ...f.input, name: 'other' });
  await f.dashboard.sync.apply(other.operationId, {});
  const otherState = await f.dashboard.sync.wait(other.operationId);
  if (!otherState.result) throw new Error('Other workspace unavailable');
  const otherToken = (
    await readFile(join(otherState.result.workspace, '.repo-cloak/agent/token'), 'utf8')
  ).trim();
  const request = (await (
    await call('/agent/v1/requests', f.token, 'POST', {
      clientRequestId: 'private-request',
      paths: ['more.ts'],
      reason: 'Need context',
    })
  ).json()) as { id: string };
  expect((await call(`/agent/v1/requests/${request.id}`, otherToken)).status).toBe(400);
  const forged = `${otherState.result.workspaceId}.${f.token.split('.')[1]}`;
  expect((await call('/agent/v1/info', forged)).status).toBe(401);
});

it('audits agent request approvals and denials with paths only', async () => {
  const f = await fixture();
  const request = (await f.dashboard.agents.agentCall(f.doc, 'requests', {
    clientRequestId: 'audit-1',
    paths: ['NorthwindContext.ts', 'more.ts'],
    reason: 'Need types',
  })) as { id: string };
  await f.dashboard.agents.reject(f.repoId, f.workspaceId, request.id, { paths: ['more.ts'] });
  const preview = await f.dashboard.agents.preview(f.repoId, f.workspaceId, request.id, {
    paths: ['NorthwindContext.ts'],
  });
  await f.dashboard.agents.apply(f.repoId, f.workspaceId, preview.operationId);
  expect((await f.dashboard.sync.wait(preview.operationId)).state).toBe('completed');
  const { events } = await f.dashboard.sync.audit.list();
  expect(events.find((event) => event.op === 'agent-deny')).toMatchObject({
    outcome: 'ok',
    workspace: { repoId: f.repoId, id: f.workspaceId },
    files: [{ path: 'more.ts' }],
    detail: `Request ${request.id}`,
  });
  expect(events.find((event) => event.op === 'agent-approve')).toMatchObject({
    outcome: 'ok',
    files: [{ path: 'NorthwindContext.ts' }],
  });
  expect(events.filter((event) => event.op === 'pull')).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain('class ');
  expect(await f.dashboard.sync.audit.verify()).toMatchObject({ ok: true });
});

it('audits only the files a denial actually changed', async () => {
  const f = await fixture();
  const request = (await f.dashboard.agents.agentCall(f.doc, 'requests', {
    clientRequestId: 'audit-deny',
    paths: ['NorthwindContext.ts', 'more.ts'],
    reason: 'Need types',
  })) as { id: string };
  const preview = await f.dashboard.agents.preview(f.repoId, f.workspaceId, request.id, {
    paths: ['NorthwindContext.ts'],
  });
  await f.dashboard.agents.apply(f.repoId, f.workspaceId, preview.operationId);
  await f.dashboard.sync.wait(preview.operationId);
  await f.dashboard.agents.reject(f.repoId, f.workspaceId, request.id, {
    paths: ['NorthwindContext.ts', 'more.ts', 'never-requested.ts'],
  });
  const { events } = await f.dashboard.sync.audit.list();
  expect(events.find((event) => event.op === 'agent-deny')?.files).toEqual([{ path: 'more.ts' }]);
});

it('still shows queued requests when the workspace context is broken', async () => {
  const f = await fixture();
  const request = (await f.dashboard.agents.agentCall(f.doc, 'requests', {
    clientRequestId: 'broken-context',
    paths: ['more.ts'],
    reason: 'Need types',
  })) as { id: string };
  await f.dashboard.deleteProfile({ id: f.profile.id, scope: f.profile.scope });
  const info = await f.dashboard.agents.info(f.repoId, f.workspaceId);
  expect(info.requests.map((item) => item.id)).toContain(request.id);
  await f.dashboard.agents.reject(f.repoId, f.workspaceId, request.id, { paths: ['more.ts'] });
});
