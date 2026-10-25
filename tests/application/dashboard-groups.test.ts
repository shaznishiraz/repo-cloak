import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  lstat,
  symlink,
  rename,
  readlink,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'smol-toml';
import { createDashboard } from '../../src/application/dashboard.js';
import { createDashboardGroups } from '../../src/application/dashboard-groups.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createUiOperations } from '../../src/adapters/ui-operations.js';
import { createGroupFolder } from '../../src/adapters/group-folder.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak groups ')));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10 }));
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
    await writeFile(join(source, `${name}.ts`), `class ${name} {}`);
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
    expect(result.state).toBe('completed');
    if (!result.result) throw new Error('Workspace was not created');
    members.push({
      repoId,
      workspaceId: result.result.workspaceId,
      worktree: source,
      destination,
      name,
    });
  }
  const input = {
    name: 'Storefront',
    members: members.map(({ repoId, workspaceId, worktree }) => ({
      repoId,
      workspaceId,
      worktree,
    })),
  };
  const [backend, frontend] = members;
  if (!backend || !frontend) throw new Error('Expected two repository fixtures');
  return { root, store, dashboard, services, members: [backend, frontend] as const, input };
}

it('initializes Git for moved legacy cloak folders and keeps credentials out of history', async () => {
  const f = await fixture();
  for (const member of f.members) await rm(join(member.destination, '.git'), { recursive: true });
  const group = await f.dashboard.groups.save({ ...f.input, moveWorkspaces: true });
  for (const member of group.members) {
    const workspace = await f.dashboard.sync.workspaceTarget(member.repoId, member.workspaceId);
    const tracked = await f.services.git.runGit(workspace.path, ['ls-files']);
    expect(tracked).toContain('.repo-cloak/manifest.json');
    expect(tracked).toContain('Safe');
    expect(tracked).not.toContain('token');
    expect((await f.services.git.runGit(workspace.path, ['log', '-1', '--format=%s'])).trim()).toBe(
      'Initialize grouped cloak workspace',
    );
  }
});

it('starts with one repo, adds another to an existing sealed group and preserves workspace data on removal', async () => {
  const f = await fixture();
  const first = await f.dashboard.groups.save({ ...f.input, members: [f.input.members[0]] });
  const group = await f.dashboard.groups.save(f.input, first.id, first.revision);
  expect(group.members).toHaveLength(2);
  const saved = await readFile(join(f.store.root, 'groups', `${group.id}.json`), 'utf8');
  expect(saved).not.toContain('Storefront');
  expect(saved).not.toContain(f.members[0].worktree);
  const reopened = createDashboard(f.store, f.members[0].worktree);
  cleanups.push(async () => reopened.sync.close());
  expect((await reopened.context()).repoId).toBe(f.members[0].repoId);
  expect(await reopened.groups.list()).toEqual([group]);
  await expect(
    f.dashboard.groups.save({ ...f.input, name: 'Stale' }, group.id, first.revision),
  ).rejects.toThrow(/changed/);
  await expect(
    f.dashboard.groups.save({ ...f.input, members: [f.input.members[0], f.input.members[0]] }),
  ).rejects.toThrow(/once|unique/);
  await expect(
    f.dashboard.groups.save({
      ...f.input,
      members: [{ ...f.input.members[0], workspaceId: '__proto__' }],
    }),
  ).rejects.toThrow(/registered/);
  await expect(
    f.dashboard.groups.save({
      ...f.input,
      members: [{ ...f.input.members[0], worktree: f.members[1].worktree }],
    }),
  ).rejects.toThrow(/worktree/);
  await f.dashboard.groups.remove(group.id, group.revision);
  expect(await f.dashboard.groups.list()).toEqual([]);
  expect((await f.dashboard.overview()).every((repo) => repo.workspaces.length === 1)).toBe(true);
  expect(await readFile(join(f.members[0].destination, 'SafeBackend.ts'), 'utf8')).toBe(
    'class SafeBackend {}',
  );
});

it('moves cloaked workspaces into a group folder with stable identities and working sync', async () => {
  const f = await fixture();
  const original = f.members[0];
  const originalManifest = await readFile(join(original.destination, '.repo-cloak/manifest.json'));
  const originalToken = await readFile(
    join(original.destination, '.repo-cloak/agent/token'),
    'utf8',
  );
  await f.dashboard.installAgentClient(original.repoId, original.workspaceId, 'codex', {
    confirm: true,
  });
  const connection = await f.dashboard.agentClientConfig(original.repoId, original.workspaceId);
  const configPath = join(original.destination, '.codex/config.toml');
  await writeFile(configPath, '# Keep my comment\n' + (await readFile(configPath, 'utf8')));
  await writeFile(join(original.destination, '.mcp.json'), connection.claude);
  await writeFile(join(original.worktree, 'Extra.ts'), 'export const context = true;');
  const grant = await f.dashboard.agents.authenticate(originalToken.trim());
  if (!grant) throw new Error('Missing scoped credential');
  const queued = await f.dashboard.agents.agentCall(grant, 'requests', {
    paths: ['Extra.ts'],
    reason: 'Need context',
    clientRequestId: 'move-queue',
  });
  await mkdir(join(original.destination, 'node_modules/local-test'), { recursive: true });
  await writeFile(
    join(original.destination, 'node_modules/local-test/index.js'),
    'module.exports = true;',
  );
  await symlink(
    join(original.destination, 'node_modules/local-test'),
    join(original.destination, 'node_modules/local-alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(
    join(original.destination, 'SafeBackend.ts'),
    'class SafeBackend { local = true }',
  );
  await f.services.git.runGit(original.destination, ['init', '-b', 'cloak']);
  await f.services.git.runGit(original.destination, [
    'add',
    'SafeBackend.ts',
    '.repo-cloak/manifest.json',
  ]);
  await f.services.git.runGit(original.destination, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    '-c',
    'commit.gpgSign=false',
    '-c',
    `core.hooksPath=${join(f.root, 'no-hooks')}`,
    'commit',
    '-m',
    'Original cloak history',
  ]);
  const originalHead = await f.services.git.runGit(original.destination, ['rev-parse', 'HEAD']);
  const group = await f.dashboard.groups.save({ ...f.input, moveWorkspaces: true });
  expect(group.folder).toBeTruthy();
  if (!group.folder) throw new Error('Missing group folder');
  expect((await lstat(group.folder)).isDirectory()).toBe(true);
  const copies = await Promise.all(
    group.members.map((member) =>
      f.dashboard.sync.workspaceTarget(member.repoId, member.workspaceId),
    ),
  );
  for (const [index, copy] of copies.entries()) {
    const previous = f.members[index];
    const member = group.members[index];
    if (!previous || !member) throw new Error('Missing moved member');
    const repo = await f.services.store.readRepo(member.repoId);
    if (!repo) throw new Error('Missing repository');
    expect(dirname(copy.path)).toBe(group.folder);
    expect((await lstat(copy.path)).isSymbolicLink()).toBe(false);
    expect(copy.snapshot.plain.workspaceId).toBe(f.members[index]?.workspaceId);
    await expect(lstat(previous.destination)).rejects.toThrow();
    expect(Object.keys(repo.workspaces)).toEqual([previous.workspaceId]);
  }
  const backend = copies[0];
  if (!backend) throw new Error('Missing moved backend');
  expect(await readFile(join(backend.path, '.repo-cloak/manifest.json'))).toEqual(originalManifest);
  expect(await readFile(join(backend.path, '.repo-cloak/agent/token'), 'utf8')).toBe(originalToken);
  expect(await realpath(join(backend.path, 'node_modules/local-alias'))).toBe(
    join(backend.path, 'node_modules/local-test'),
  );
  expect(await f.services.git.runGit(backend.path, ['rev-parse', 'HEAD'])).toBe(originalHead);
  expect((await f.services.git.findRepo(backend.path))?.commonDir).toBe(join(backend.path, '.git'));
  expect(await readFile(join(backend.path, 'SafeBackend.ts'), 'utf8')).toContain('local = true');
  const token = (await readFile(join(backend.path, '.repo-cloak/agent/token'), 'utf8')).trim();
  expect(await readFile(join(backend.path, '.repo-cloak/agent/SKILL.md'), 'utf8')).toContain(
    'name: repo-cloak',
  );
  expect(token).toBe(originalToken.trim());
  expect((await f.dashboard.agents.authenticate(token))?.path).toBe(backend.path);
  const after = await f.dashboard.agents.info(original.repoId, original.workspaceId);
  expect(after.requests.map((request) => request.id)).toContain((queued as { id: string }).id);
  const movedConfig = await readFile(join(backend.path, '.codex/config.toml'), 'utf8');
  expect(movedConfig).toContain('# Keep my comment');
  expect(movedConfig).toContain(JSON.stringify(backend.path));
  expect(movedConfig).not.toContain(JSON.stringify(original.destination));
  expect(await readFile(join(backend.path, '.mcp.json'), 'utf8')).toContain(
    JSON.stringify(backend.path),
  );
  const rootInstructions = await readFile(join(group.folder, 'AGENTS.md'), 'utf8');
  expect(rootInstructions).toContain('repo-cloak group');
  expect(rootInstructions).not.toContain(original.worktree);
  const config = parse(await readFile(join(group.folder, '.codex/config.toml'), 'utf8'));
  expect(Object.keys(config.mcp_servers ?? {})).toHaveLength(2);
  const rootContext = createDashboard(f.store, group.folder);
  cleanups.push(async () => rootContext.sync.close());
  expect(await rootContext.context()).toEqual({ groupId: group.id });
  await writeFile(join(backend.path, 'SafeBackend.ts'), 'class SafeBackend { grouped = true }');
  const push = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
  });
  await f.dashboard.groups.apply(push.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(push.operationId)).state).toBe('completed');
  expect(await readFile(join(original.worktree, 'Backend.ts'), 'utf8')).toContain('grouped = true');
  await expect(lstat(join(original.worktree, 'node_modules'))).rejects.toThrow();
  await expect(lstat(original.destination)).rejects.toThrow();
  const edited = await f.dashboard.groups.save(
    { name: 'Renamed', members: group.members, moveWorkspaces: true },
    group.id,
    group.revision,
  );
  expect(edited.members).toEqual(group.members);
  expect(edited.folder).toBe(group.folder);
  const helper = await readFile(join(group.folder, 'AGENTS.md'), 'utf8');
  await writeFile(join(group.folder, 'AGENTS.md'), helper + '\nUser notes\n');
  await expect(
    f.dashboard.groups.save(
      { name: 'Another edit', members: edited.members },
      edited.id,
      edited.revision,
    ),
  ).rejects.toThrow(/helper files changed/);
  expect(await readFile(join(group.folder, 'AGENTS.md'), 'utf8')).toBe(helper + '\nUser notes\n');
  await f.dashboard.removeRepository(original.repoId);
  expect(await readFile(join(group.folder, 'AGENTS.md'), 'utf8')).toBe(helper + '\nUser notes\n');
  const detached = (await f.dashboard.groups.list())[0];
  if (!detached) throw new Error('Remaining group is missing');
  expect(detached.members).toHaveLength(1);
  await f.dashboard.groups.remove(detached.id, detached.revision);
  expect(await readFile(join(backend.path, 'SafeBackend.ts'), 'utf8')).toContain('grouped = true');
});

it('keeps generated artifacts local, honors profile includes/excludes and rejects a changed exclusion before Push', async () => {
  const f = await fixture();
  const original = f.members[0];
  const group = await f.dashboard.groups.save({
    name: 'Eligibility',
    members: [f.input.members[0]],
    moveWorkspaces: true,
  });
  const member = group.members[0];
  if (!member) throw new Error('Missing copied member');
  const copy = await f.dashboard.sync.workspaceTarget(member.repoId, member.workspaceId);
  const profile = (await f.dashboard.profiles(original.repoId))[0];
  if (!profile) throw new Error('Missing profile');
  await f.dashboard.saveProfile({
    ...profile,
    profile: { ...profile.profile, include: ['dist/'], exclude: ['private.ts'] },
  });
  await mkdir(join(copy.path, 'dist'));
  await mkdir(join(copy.path, 'node_modules'));
  await writeFile(join(copy.path, 'dist/generated.ts'), 'export const generated = true;');
  await writeFile(join(copy.path, 'node_modules/dependency.js'), 'module.exports = true;');
  await writeFile(join(copy.path, 'private.ts'), 'never push this');
  await writeFile(join(copy.path, 'SafeBackend.ts'), 'class SafeBackend { changed = true }');
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
  });
  expect(preview.writes).toEqual(expect.arrayContaining(['Backend.ts', 'dist/generated.ts']));
  expect(preview.writes.join()).not.toMatch(/private|node_modules/);
  await f.dashboard.saveProfile({
    ...profile,
    profile: {
      ...profile.profile,
      include: ['dist/'],
      exclude: ['private.ts', 'dist/generated.ts', 'Backend.ts'],
    },
  });
  await f.dashboard.groups.apply(preview.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(preview.operationId)).state).toBe('failed');
  expect(await readFile(join(original.worktree, 'Backend.ts'), 'utf8')).toBe('class Backend {}');
  await expect(readFile(join(original.worktree, 'dist/generated.ts'))).rejects.toThrow();
  const fresh = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
  });
  expect(fresh.writes).toEqual([]);
});

it('installs guidance in moved legacy workspaces while preserving local edits', async () => {
  const f = await fixture();
  const original = f.members[0];
  const snapshot = await f.services.store.readSnapshot(original.destination);
  if (!snapshot) throw new Error('Missing original snapshot');
  delete snapshot.data.guidance;
  await writeFile(
    join(original.destination, '.repo-cloak/manifest.json'),
    await f.services.store.sealManifest(snapshot),
  );
  await writeFile(join(original.destination, 'AGENTS.md'), '# My instructions\n');
  await rm(join(original.destination, 'CLAUDE.md'));
  await writeFile(
    join(original.destination, 'SafeBackend.ts'),
    'class SafeBackend { legacyEdit = true }',
  );
  const group = await f.dashboard.groups.save({
    name: 'Legacy',
    members: [f.input.members[0]],
    moveWorkspaces: true,
  });
  const member = group.members[0];
  if (!member) throw new Error('Missing copied member');
  const copy = await f.dashboard.sync.workspaceTarget(member.repoId, member.workspaceId);
  expect(await readFile(join(copy.path, 'AGENTS.md'), 'utf8')).toContain('# My instructions');
  expect(await readFile(join(copy.path, 'AGENTS.md'), 'utf8')).toContain('repo-cloak workspace');
  await expect(lstat(original.destination)).rejects.toThrow();
  const push = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
  });
  await f.dashboard.groups.apply(push.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(push.operationId)).state).toBe('completed');
  expect(await readFile(join(original.worktree, 'Backend.ts'), 'utf8')).toContain(
    'legacyEdit = true',
  );
  expect(await readFile(join(original.worktree, 'AGENTS.md'), 'utf8')).toBe('# My instructions\n');
  await expect(readFile(join(original.worktree, 'CLAUDE.md'))).rejects.toThrow();
});

it('refuses unsafe moves and restores folders and registrations when group saving fails', async () => {
  const f = await fixture();
  const original = f.members[0];
  await f.dashboard.installAgentClient(original.repoId, original.workspaceId, 'codex', {
    confirm: true,
  });
  const originalConfig = await readFile(join(original.destination, '.codex/config.toml'));
  const link = join(original.destination, 'internal-link.ts');
  const linkTarget = join(original.destination, 'SafeBackend.ts');
  await symlink(linkTarget, link, 'file');
  const before = await f.dashboard.overview();
  await symlink(
    f.members[0].worktree,
    join(f.members[0].destination, 'external'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(f.dashboard.groups.save({ ...f.input, moveWorkspaces: true })).rejects.toThrow(
    /symbolic|symlink/i,
  );
  expect(await f.dashboard.overview()).toEqual(before);
  expect(await f.dashboard.groups.list()).toEqual([]);
  await rm(join(f.members[0].destination, 'external'));
  await expect(
    f.dashboard.groups.save({
      ...f.input,
      moveWorkspaces: true,
      folderRoot: f.members[0].worktree,
    }),
  ).rejects.toThrow(/outside|repository|repositories/);
  const write = f.store.writeSealed.bind(f.store);
  const fail = vi.spyOn(f.store, 'writeSealed').mockImplementation(async (...args) => {
    if (args[2] === 'group') throw new Error('Simulated group save failure');
    await write(...args);
  });
  try {
    await expect(f.dashboard.groups.save({ ...f.input, moveWorkspaces: true })).rejects.toThrow(
      /Simulated/,
    );
  } finally {
    fail.mockRestore();
  }
  expect(await f.dashboard.overview()).toEqual(before);
  expect(await f.dashboard.groups.list()).toEqual([]);
  expect(await f.store.listFiles('agents')).toHaveLength(2);
  expect(await readFile(join(original.destination, '.codex/config.toml'))).toEqual(originalConfig);
  expect(await readlink(link)).toBe(linkTarget);
});

it('refuses cross-filesystem moves without leaving a second workspace or changing registration', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  const before = await f.dashboard.overview();
  const targets = await Promise.all(
    group.members.map(async (member) => ({
      ...member,
      ...(await f.dashboard.sync.workspaceTarget(member.repoId, member.workspaceId)),
    })),
  );
  const folders = createGroupFolder(f.store, async (from, to) => {
    if (from === f.members[1].destination)
      throw Object.assign(new Error('Different filesystem'), { code: 'EXDEV' });
    await rename(from, to);
  });
  await expect(folders.save(group, targets, undefined, async () => group)).rejects.toThrow(
    /same filesystem/,
  );
  expect(await f.dashboard.overview()).toEqual(before);
  for (const member of f.members)
    expect((await lstat(member.destination)).isDirectory()).toBe(true);
  await expect(lstat(join(f.root, `group-${group.id.slice(0, 8)}`))).rejects.toThrow();
});

it('reuses moved members on group edits and refuses to move them out of another active group', async () => {
  const f = await fixture();
  const first = await f.dashboard.groups.save({
    ...f.input,
    members: [f.input.members[0]],
    moveWorkspaces: true,
  });
  const member = first.members[0];
  if (!member) throw new Error('Missing first member');
  const existing = await f.dashboard.sync.workspaceTarget(member.repoId, member.workspaceId);
  const edited = await f.dashboard.groups.save(
    { ...f.input, moveWorkspaces: true },
    first.id,
    first.revision,
  );
  expect(edited.members).toEqual(f.input.members);
  expect((await f.dashboard.sync.workspaceTarget(member.repoId, member.workspaceId)).path).toBe(
    existing.path,
  );
  await expect(
    f.dashboard.groups.save({ ...f.input, name: 'Other', moveWorkspaces: true }),
  ).rejects.toThrow(/another group/);
  expect((await f.dashboard.groups.list()).map((group) => group.id)).toEqual([edited.id]);
});

it('removes a repository from the dashboard and groups while retaining its files and saved setup', async () => {
  const f = await fixture();
  const [backend, frontend] = f.members;
  await f.dashboard.sync.saveExclusions(backend.repoId, { patterns: ['private.txt'] });
  const profiles = await f.dashboard.profiles(backend.repoId);
  const group = await f.dashboard.groups.save(f.input);
  await f.dashboard.groups.save({ name: 'Backend only', members: [f.input.members[0]] });
  const batch = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'refresh',
  });
  const individual = await f.dashboard.sync.preview({ ...f.input.members[0], intent: 'refresh' });
  const manifest = await readFile(join(backend.destination, '.repo-cloak/manifest.json'));
  await f.dashboard.sync.operations.exclusive(async () => {
    await expect(f.dashboard.removeRepository(backend.repoId)).rejects.toThrow(/running/);
  });
  await f.dashboard.removeRepository(backend.repoId);
  await f.dashboard.removeRepository(backend.repoId); // Repeated DELETE is harmless.
  expect((await f.dashboard.overview()).map((repo) => repo.id)).toEqual([frontend.repoId]);
  expect(await f.services.store.listRepos()).toEqual([
    { repoId: frontend.repoId, path: frontend.worktree },
  ]);
  expect(await f.dashboard.groups.list()).toMatchObject([
    { id: group.id, members: [f.input.members[1]] },
  ]);
  expect((await f.dashboard.groups.list())[0]?.members).toHaveLength(1);
  expect(await readFile(join(backend.worktree, 'Backend.ts'), 'utf8')).toBe('class Backend {}');
  expect(await readFile(join(backend.destination, '.repo-cloak/manifest.json'))).toEqual(manifest);
  expect(await readFile(join(backend.destination, 'SafeBackend.ts'), 'utf8')).toBe(
    'class SafeBackend {}',
  );
  await expect(f.dashboard.sync.worktrees(backend.repoId)).rejects.toThrow(/not registered/);
  await expect(f.dashboard.groups.apply(batch.operationId, { members: [] })).rejects.toThrow(
    /changed/,
  );
  await f.dashboard.sync.apply(individual.operationId, {});
  expect((await f.dashboard.sync.wait(individual.operationId)).state).toBe('failed');
  await f.dashboard.addRepository({ path: backend.worktree });
  expect(
    (await f.dashboard.overview()).find((repo) => repo.id === backend.repoId)?.workspaces,
  ).toMatchObject([{ id: backend.workspaceId }]);
  expect(await f.dashboard.profiles(backend.repoId)).toEqual(profiles);
  expect((await f.services.store.readRepo(backend.repoId))?.exclude).toEqual(['private.txt']);
  // Removal does not restore old group membership when the source is added back.
  expect((await f.dashboard.groups.list())[0]?.members).toHaveLength(1);
  await f.dashboard.removeRepository(backend.repoId);
  const reopened = createDashboard(f.store, backend.worktree);
  cleanups.push(async () => reopened.sync.close());
  await reopened.context();
  expect((await reopened.overview()).some((repo) => repo.id === backend.repoId)).toBe(true);
  await rm(frontend.worktree, { recursive: true });
  await f.dashboard.removeRepository(frontend.repoId);
  expect(await f.dashboard.groups.list()).toEqual([]);
  expect((await f.dashboard.overview()).map((repo) => repo.id)).toEqual([backend.repoId]);
  expect(await readFile(join(frontend.destination, 'SafeFrontend.ts'), 'utf8')).toBe(
    'class SafeFrontend {}',
  );
});

it('previews all members without writes, pulls and pushes both using separate profiles and exclusions', async () => {
  const f = await fixture();
  const group = await f.dashboard.groups.save(f.input);
  for (const member of f.members) {
    await writeFile(
      join(member.worktree, `${member.name}.ts`),
      `class ${member.name} { source = true }`,
    );
    await writeFile(join(member.worktree, 'private.txt'), 'do not copy');
    await f.dashboard.sync.saveExclusions(member.repoId, { patterns: ['private.txt'] });
  }
  const batch = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'refresh',
  });
  expect(batch.members).toHaveLength(2);
  expect(await readFile(join(f.members[0].destination, 'SafeBackend.ts'), 'utf8')).toBe(
    'class SafeBackend {}',
  );
  await f.dashboard.groups.apply(batch.operationId, { members: [] });
  const done = await f.dashboard.groups.wait(batch.operationId);
  expect(done.state).toBe('completed');
  expect(done.members.map((member) => member.state)).toEqual(['completed', 'completed']);
  expect((await f.dashboard.groups.apply(batch.operationId, { members: [] })).state).toBe(
    'completed',
  );
  for (const member of f.members) {
    expect(await readFile(join(member.destination, `Safe${member.name}.ts`), 'utf8')).toContain(
      'source = true',
    );
    await expect(readFile(join(member.destination, 'private.txt'))).rejects.toThrow();
    await writeFile(
      join(member.destination, `Safe${member.name}.ts`),
      `class Safe${member.name} { agent = true }`,
    );
    await writeFile(join(member.destination, 'private.txt'), 'never restore');
  }
  const push = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
  });
  await f.dashboard.groups.apply(push.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(push.operationId)).state).toBe('completed');
  for (const member of f.members) {
    expect(await readFile(join(member.worktree, `${member.name}.ts`), 'utf8')).toBe(
      `class ${member.name} { agent = true }`,
    );
    expect(await readFile(join(member.worktree, 'private.txt'), 'utf8')).toBe('do not copy');
  }
}, 15_000);

it('requires per-member review and rejects changed groups, missing members and stale preflight before writes', async () => {
  const f = await fixture();
  let group = await f.dashboard.groups.save(f.input);
  await rm(join(f.members[0].destination, 'SafeBackend.ts'));
  const preview = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'restore',
  });
  await expect(f.dashboard.groups.apply(preview.operationId, { members: [] })).rejects.toThrow(
    /deletions/,
  );
  await expect(
    f.dashboard.sync.apply(preview.operationId, { deletions: true, profiles: true }),
  ).rejects.toThrow(/group review/);
  await expect(
    f.dashboard.groups.apply(preview.operationId, {
      members: [{ repoId: f.members[1].repoId, deletions: true }],
    }),
  ).rejects.toThrow(/deletions/);
  await f.dashboard.groups.apply(preview.operationId, {
    members: [{ repoId: f.members[0].repoId, deletions: true }],
  });
  expect((await f.dashboard.groups.wait(preview.operationId)).state).toBe('completed');
  await expect(readFile(join(f.members[0].worktree, 'Backend.ts'))).rejects.toThrow();

  const pending = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'refresh',
  });
  group = await f.dashboard.groups.save({ ...f.input, name: 'Renamed' }, group.id, group.revision);
  await expect(f.dashboard.groups.apply(pending.operationId, { members: [] })).rejects.toThrow(
    /changed/,
  );
  f.dashboard.groups.cancel(pending.operationId);
  const stale = await f.dashboard.groups.preview(group.id, {
    revision: group.revision,
    intent: 'refresh',
  });
  await writeFile(join(f.members[1].worktree, 'Frontend.ts'), 'changed after preview');
  await f.dashboard.groups.apply(stale.operationId, { members: [] });
  expect((await f.dashboard.groups.wait(stale.operationId)).state).toBe('failed');
  expect(
    f.dashboard.groups
      .status(stale.operationId)
      .members.every((member) => member.state !== 'completed'),
  ).toBe(true);
  await rm(f.members[1].destination, { recursive: true });
  await expect(
    f.dashboard.groups.preview(group.id, { revision: group.revision, intent: 'refresh' }),
  ).rejects.toThrow(/manifest|missing/);
  await rm(f.members[0].worktree, { recursive: true });
  expect(
    (await f.dashboard.overview()).find((repo) => repo.id === f.members[0].repoId)?.missing,
  ).toBe(true);
  await expect(
    f.dashboard.groups.preview(group.id, { revision: group.revision, intent: 'refresh' }),
  ).rejects.toThrow();
});

it('holds the queue for a batch, reports partial failure and retries only unfinished members', async () => {
  const f = await fixture();
  const applied: string[] = [];
  let fail = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const groups = createDashboardGroups(f.store, {
    ...f.dashboard.sync,
    async prepareOperation(value) {
      const operation = await f.dashboard.sync.prepareOperation(value);
      const repoId = (value as { repoId: string }).repoId;
      return {
        ...operation,
        async apply() {
          applied.push(repoId);
          if (repoId === f.members[0].repoId) await gate;
          if (repoId === f.members[1].repoId && fail) throw new Error('Simulated writer failure');
          return operation.apply();
        },
      };
    },
  });
  const group = await groups.save(f.input);
  const preview = await groups.preview(group.id, { revision: group.revision, intent: 'refresh' });
  const individual = await f.dashboard.sync.preview({ ...f.input.members[0], intent: 'refresh' });
  await groups.apply(preview.operationId, { members: [] });
  await expect(groups.remove(group.id, group.revision)).rejects.toThrow(/running/);
  await expect(f.dashboard.sync.apply(individual.operationId, {})).rejects.toThrow(/running/);
  release();
  const failed = await groups.wait(preview.operationId);
  expect(failed.state).toBe('failed');
  expect(failed.members.map((member) => member.state)).toEqual(['completed', 'failed']);
  fail = false;
  const retry = await groups.retry(preview.operationId);
  expect(retry.members).toHaveLength(1);
  await groups.apply(retry.operationId, { members: [] });
  expect((await groups.wait(retry.operationId)).state).toBe('completed');
  expect(applied).toEqual([f.members[0].repoId, f.members[1].repoId, f.members[1].repoId]);
  f.dashboard.sync.cancel(individual.operationId);
});

it('rejects overlapping targets and enforces preview memory limits and expiry for whole batches', async () => {
  const f = await fixture();
  const overlap = createDashboardGroups(f.store, {
    ...f.dashboard.sync,
    async workspaceTarget(repoId, id) {
      const target = await f.dashboard.sync.workspaceTarget(repoId, id);
      return { ...target, path: f.members[0].worktree };
    },
  });
  await expect(overlap.save(f.input)).rejects.toThrow(/overlapping/);
  await expect(
    f.dashboard.groups.save({ name: 'Too many', members: Array(9).fill(f.input.members[0]) }),
  ).rejects.toThrow();
  const group = await f.dashboard.groups.save(f.input);
  const operations = createUiOperations({ maxBytes: 1 });
  cleanups.push(async () => operations.close());
  const limited = createDashboardGroups(f.store, { ...f.dashboard.sync, operations });
  await expect(
    limited.preview(group.id, { revision: group.revision, intent: 'refresh' }),
  ).rejects.toThrow(/memory limit/);
  let now = 0;
  const expiring = createUiOperations({ now: () => now, ttl: 10 });
  cleanups.push(async () => expiring.close());
  const groups = createDashboardGroups(f.store, { ...f.dashboard.sync, operations: expiring });
  const batch = await groups.preview(group.id, { revision: group.revision, intent: 'refresh' });
  now = 11;
  expect(groups.status(batch.operationId).state).toBe('expired');
  expect((await groups.apply(batch.operationId, { members: [] })).state).toBe('expired');
});
