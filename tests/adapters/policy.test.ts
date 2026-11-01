import { generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadPolicy, policyDirectory } from '../../src/adapters/policy.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import type { LoadedPolicy } from '../../src/core/policy.js';
import { policySchema } from '../../src/core/policy.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak policy ')));
  roots.push(root);
  return root;
}
const body = JSON.stringify({ schemaVersion: 1, auditRetentionDays: 30 });
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    sign: (text: string) => sign(null, Buffer.from(text), privateKey).toString('base64'),
  };
}

it('resolves the machine-wide directory per platform', () => {
  expect(policyDirectory('darwin')).toBe('/Library/Application Support/repo-cloak');
  expect(policyDirectory('linux')).toBe('/etc/repo-cloak');
  expect(policyDirectory('win32', { ProgramData: 'D:\\Data' })).toBe('D:\\Data\\repo-cloak');
  expect(policyDirectory('win32', {})).toBe('C:\\ProgramData\\repo-cloak');
});

it('reports no policy when the file is absent', async () => {
  expect(await loadPolicy(await directory())).toEqual({ status: 'none' });
});

it('loads an unsigned policy and notes when this user could edit it', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'policy.json'), body);
  expect(await loadPolicy(dir)).toMatchObject({
    status: 'active',
    signed: false,
    userWritable: true,
    policy: { auditRetentionDays: 30 },
  });
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'recognises a file this user cannot write',
  async () => {
    const dir = await directory();
    await writeFile(join(dir, 'policy.json'), body);
    await chmod(join(dir, 'policy.json'), 0o444);
    expect(await loadPolicy(dir)).toMatchObject({ status: 'active', userWritable: false });
  },
);

it('accepts a valid Ed25519 signature', async () => {
  const dir = await directory();
  const keys = signer();
  await writeFile(join(dir, 'policy.json'), body);
  await writeFile(join(dir, 'policy.json.sig'), `${keys.sign(body)}\n`);
  await writeFile(join(dir, 'policy.pub'), keys.publicKey);
  expect(await loadPolicy(dir)).toMatchObject({ status: 'active', signed: true });
});

it.each([
  ['an edited policy', 'tampered', 'signature does not match'],
  ['a signature from another key', 'foreign', 'signature does not match'],
  ['a missing signature', 'unsigned', 'requires a signed policy'],
  ['a signature with no public key', 'no-key', 'policy.pub is missing'],
  ['a non-Ed25519 key', 'rsa', 'not an Ed25519 key'],
])('rejects %s', async (_name, scenario, message) => {
  const dir = await directory();
  const keys = signer();
  await writeFile(
    join(dir, 'policy.json'),
    scenario === 'tampered' ? body.replace('30', '3000') : body,
  );
  const signature = scenario === 'foreign' ? signer().sign(body) : keys.sign(body);
  if (scenario !== 'unsigned') await writeFile(join(dir, 'policy.json.sig'), signature);
  if (scenario === 'rsa') {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await writeFile(join(dir, 'policy.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
  } else if (scenario !== 'no-key') await writeFile(join(dir, 'policy.pub'), keys.publicKey);
  const result = await loadPolicy(dir);
  expect(result.status).toBe('invalid');
  expect(result).toMatchObject({ message: expect.stringContaining(message) });
});

it.each([
  ['broken JSON', '{nope'],
  ['an unknown field', JSON.stringify({ schemaVersion: 1, surprise: 1 })],
  ['an oversized file', ' '.repeat(1024 * 1024 + 1)],
])('treats %s as invalid, never as no policy', async (_name, content) => {
  const dir = await directory();
  await writeFile(join(dir, 'policy.json'), content);
  expect((await loadPolicy(dir)).status).toBe('invalid');
});

async function dashboardWith(loaded: LoadedPolicy) {
  const root = await directory();
  const source = join(root, 'Acme');
  await mkdir(source);
  const store = createStore(join(root, 'store'), { policy: async () => loaded });
  const services = createSyncServices(source, store);
  await services.git.runGit(source, ['init', '-b', 'main']);
  const git = ['-c', 'user.name=T', '-c', 'user.email=t@example.com'];
  await writeFile(join(source, 'Acme.ts'), 'class Acme {}');
  await writeFile(join(source, 'Secret.pem'), 'pem-data');
  await writeFile(join(source, 'Other.log'), 'log-data');
  await services.git.runGit(source, ['add', '-A']);
  await services.git.runGit(source, [...git, 'commit', '-qm', 'one']);
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
  return { root, source, store, services, dashboard, repoId, profile };
}
const active = (policy: Record<string, unknown>): LoadedPolicy => ({
  status: 'active',
  policy: policySchema.parse({ schemaVersion: 1, ...policy }),
  path: '/etc/repo-cloak/policy.json',
  signed: true,
  userWritable: false,
});

it('locks a setting: reports it, overrides the user value and rejects changes', async () => {
  const f = await dashboardWith(active({ auditRetentionDays: 365, autoLockMinutes: 15 }));
  await f.services.store.saveConfig({
    kind: 'config',
    schemaVersion: 1,
    initGit: false,
    auditRetentionDays: 7,
  });
  const security = await f.dashboard.settings.security();
  expect(security).toMatchObject({
    auditRetentionDays: 365,
    autoLockMinutes: 15,
    locked: ['auditRetentionDays', 'autoLockMinutes'],
    policy: { status: 'active', signed: true },
  });
  await expect(f.dashboard.settings.saveSecurity({ auditRetentionDays: 1 })).rejects.toThrow(
    /locked by machine policy/,
  );
  expect((await f.services.store.readConfig()).auditRetentionDays).toBe(7);
  // Saving the value the policy already enforces, or another field, is fine.
  await f.dashboard.settings.saveSecurity({ auditRetentionDays: 365 });
  await f.dashboard.settings.saveSecurity({ allowExclusionOverride: false });
  expect((await f.dashboard.settings.security()).allowExclusionOverride).toBe(false);
  const session = await f.dashboard.shell.session(1);
  expect(session.policy).toEqual({
    status: 'active',
    locked: ['auditRetentionDays', 'autoLockMinutes'],
  });
});

it('enforces locked exclusions on pulls without writing them into the repo record', async () => {
  const f = await dashboardWith(active({ lockedExclusions: ['*.pem'] }));
  await expect(
    f.dashboard.sync.preview({
      intent: 'create',
      repoId: f.repoId,
      worktree: f.source,
      destination: join(f.root, 'workspace'),
      profiles: [{ id: f.profile.id, scope: f.profile.scope }],
      files: ['Acme.ts', 'Secret.pem'],
    }),
  ).rejects.toThrow(/excluded/);
  expect((await f.services.store.readRepo(f.repoId))?.exclude).toEqual(['*.pem']);
  await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['*.pem', '*.log'] });
  expect((await f.services.store.readRepoRecord(f.repoId))?.exclude).toEqual(['*.log']);
  expect((await f.services.store.readRepo(f.repoId))?.exclude).toEqual(['*.pem', '*.log']);
});

async function exportFixture(loaded: LoadedPolicy) {
  const f = await dashboardWith(loaded);
  const workspace = join(f.root, 'workspace');
  const preview = await f.dashboard.sync.preview({
    intent: 'create',
    repoId: f.repoId,
    worktree: f.source,
    destination: workspace,
    profiles: [{ id: f.profile.id, scope: f.profile.scope }],
    files: ['Acme.ts'],
  });
  await f.dashboard.sync.apply(preview.operationId, {});
  const done = await f.dashboard.sync.wait(preview.operationId);
  expect(done.state).toBe('completed');
  const commit = (await f.services.git.runGit(f.source, ['rev-parse', 'HEAD'])).trim();
  const changed = (await f.services.git.commitFiles(f.source, commit)).sort();
  const attempt = (file: string) =>
    f.dashboard.sync.exportDiff(f.repoId, done.result?.workspaceId ?? '', {
      commit,
      indexes: [changed.indexOf(file)],
      includeExcluded: true,
    });
  return { ...f, attempt };
}

it('never lets the exclusion override reach a policy-locked file', async () => {
  const f = await exportFixture(active({ lockedExclusions: ['*.pem'] }));
  await expect(f.attempt('Secret.pem')).rejects.toThrow(/Machine policy excludes/);
});

it('honours a policy that forbids overrides, and fails closed on an invalid policy', async () => {
  for (const loaded of [
    active({ allowExclusionOverride: false }),
    { status: 'invalid', path: '/x', message: 'bad' } as const,
  ]) {
    const f = await exportFixture(loaded);
    await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['*.log'] });
    await expect(f.attempt('Other.log')).rejects.toThrow(/override/);
  }
});

it('keeps the override working when no policy forbids it', async () => {
  const f = await exportFixture({ status: 'none' });
  await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['*.log'] });
  await expect(f.attempt('Other.log')).resolves.toBeDefined();
});

it('applies policy retention to the audit log', async () => {
  const f = await dashboardWith(active({ auditRetentionDays: 30 }));
  await f.dashboard.settings.save({ postCreateCommands: ['echo one'] });
  // The next write prunes against the policy's 30 days, leaving this recent event in place.
  await f.dashboard.settings.save({ postCreateCommands: ['echo two'] });
  expect(await f.dashboard.sync.audit.verify()).toMatchObject({ ok: true });
  expect((await f.dashboard.sync.audit.list()).events).toHaveLength(2);
});
