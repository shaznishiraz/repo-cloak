import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runGit } from '../../src/adapters/git.js';
import { createStore } from '../../src/adapters/store.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { hashJson } from '../../src/core/hash.js';
import { createTestSync } from '../support/sync.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});
const literal = (id: string, match: string, replace: string) => ({
  id,
  type: 'literal',
  match,
  replace,
});
const profile = (name: string, extra: Record<string, unknown> = {}) => ({
  kind: 'profile',
  schemaVersion: 2,
  name,
  rules: [],
  ...extra,
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak hardening ')));
  roots.push(root);
  const source = join(root, 'source');
  const destination = join(root, 'workspace');
  const store = createStore(join(root, 'store'));
  await mkdir(join(source, 'src'), { recursive: true });
  await mkdir(join(source, 'secrets'));
  await runGit(source, ['init', '-b', 'main']);
  await runGit(source, ['config', 'core.hooksPath', join(root, 'no-hooks')]);
  await runGit(source, ['config', 'commit.gpgSign', 'false']);
  await runGit(source, ['config', 'user.name', 'Test']);
  await runGit(source, ['config', 'user.email', 'test@example.com']);
  await writeFile(join(source, 'src', 'a.ts'), 'Acme in src\n');
  await writeFile(join(source, 'secrets', 'key.ts'), 'Acme secret\n');
  await writeFile(join(source, 'top.ts'), 'Acme top\n');
  await runGit(source, ['add', '-A']);
  await runGit(source, ['commit', '-m', 'initial']);
  const services = createSyncServices(source, store);
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  const sync = createTestSync(services, '2.0.0');
  const save = (document: unknown, id?: string) =>
    services.profiles.save({ kind: 'global' }, document as never, id);
  return { root, source, destination, store, services, sync, save };
}
async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

it('pulls only what allowRoots permits from a folder selection', async () => {
  const f = await fixture();
  await f.save(profile('scoped', { rules: [literal('c', 'Acme', 'Nova')], allowRoots: ['src/'] }));
  await f.sync('push', { profiles: ['scoped'], files: ['.'], to: f.destination });
  expect(await readFile(join(f.destination, 'src/a.ts'), 'utf8')).toBe('Nova in src\n');
  expect(await exists(join(f.destination, 'secrets/key.ts'))).toBe(false);
  expect(await exists(join(f.destination, 'top.ts'))).toBe(false);
});

it('an include cannot widen allowRoots', async () => {
  const f = await fixture();
  await f.save(profile('scoped', { allowRoots: ['src/'], include: ['secrets/'] }));
  await f.sync('push', { profiles: ['scoped'], files: ['.'], to: f.destination });
  expect(await exists(join(f.destination, 'secrets/key.ts'))).toBe(false);
});

it('fails when nothing is inside the roots, writing nothing', async () => {
  const f = await fixture();
  await f.save(profile('none', { allowRoots: [] }));
  await expect(
    f.sync('push', { profiles: ['none'], files: ['.'], to: f.destination }),
  ).rejects.toThrow(/No selected source files remain/);
  expect(await exists(f.destination)).toBe(false);
});

it('refuses an exact file outside the roots by name', async () => {
  const f = await fixture();
  await f.save(profile('scoped', { allowRoots: ['src/'] }));
  await expect(
    f.sync('push', {
      profiles: ['scoped'],
      files: ['secrets/key.ts'],
      exactFiles: true,
      to: f.destination,
    }),
  ).rejects.toThrow('secrets/key.ts is outside the allowed roots');
});

it('holds back commit files outside the roots', async () => {
  const f = await fixture();
  await f.save(profile('scoped', { allowRoots: ['src/'] }));
  const head = (await runGit(f.source, ['rev-parse', 'HEAD'])).trim();
  await f.sync('push', { profiles: ['scoped'], commits: [head], to: f.destination });
  expect(await exists(join(f.destination, 'src/a.ts'))).toBe(true);
  expect(await exists(join(f.destination, 'secrets/key.ts'))).toBe(false);
});

it('a symlink inside a root cannot pull a file from outside it', async () => {
  const f = await fixture();
  await symlink('../secrets/key.ts', join(f.source, 'src', 'link.ts'));
  await f.save(profile('scoped', { allowRoots: ['src/'] }));
  await expect(
    f.sync('push', { profiles: ['scoped'], files: ['src/link.ts'], to: f.destination }),
  ).rejects.toThrow('secrets/key.ts is outside the allowed roots');
  expect(await exists(f.destination)).toBe(false);
});

it('refuses to refresh a tracked file that a profile edit put outside the roots', async () => {
  const f = await fixture();
  const saved = await f.save(profile('open', { rules: [literal('c', 'Acme', 'Nova')] }));
  await f.sync('push', { profiles: ['open'], files: ['.'], to: f.destination });
  await f.save({ ...saved.profile, allowRoots: ['src/'] }, saved.id);
  await expect(
    createTestSync(createSyncServices(f.destination, f.store), '2.0.0')('pull', { files: ['.'] }),
  ).rejects.toThrow(/outside the allowed roots|is outside/);
});

it('a new workspace file outside the roots is not eligible on push', async () => {
  const f = await fixture();
  await f.save(profile('scoped', { rules: [literal('c', 'Acme', 'Nova')], allowRoots: ['src/'] }));
  await f.sync('push', { profiles: ['scoped'], files: ['src'], to: f.destination });
  await writeFile(join(f.destination, 'outside.ts'), 'new\n');
  await writeFile(join(f.destination, 'src', 'inside.ts'), 'new\n');
  const services = createSyncServices(f.destination, f.store);
  await createTestSync(services, '2.0.0')('push', {});
  expect(await exists(join(f.source, 'src/inside.ts'))).toBe(true);
  expect(await exists(join(f.source, 'outside.ts'))).toBe(false);
});

it('applies parent rules, exclusions and roots, and records the parent', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'src', 'drop.sql'), 'Acme\n');
  await f.save(
    profile('base', {
      rules: [literal('c', 'Acme', 'Nova')],
      exclude: ['*.sql'],
      allowRoots: ['src/'],
    }),
  );
  await f.save(profile('child', { extends: ['base'], rules: [literal('d', 'in src', 'here')] }));
  await f.sync('push', { profiles: ['child'], files: ['.'], to: f.destination });
  expect(await readFile(join(f.destination, 'src/a.ts'), 'utf8')).toBe('Nova here\n');
  expect(await exists(join(f.destination, 'src/drop.sql'))).toBe(false);
  expect(await exists(join(f.destination, 'top.ts'))).toBe(false);
  const snapshot = await f.services.store.readSnapshot(f.destination);
  expect(snapshot?.data.profiles.map((ref) => ref.name)).toEqual(['base', 'child']);
});

it('a child cannot escape the roots of its parent', async () => {
  const f = await fixture();
  await f.save(profile('base', { allowRoots: ['src/'] }));
  await f.save(profile('child', { extends: ['base'], allowRoots: ['secrets/'] }));
  await expect(
    f.sync('push', { profiles: ['child'], files: ['.'], to: f.destination }),
  ).rejects.toThrow(/No selected source files remain/);
});

it('editing a parent counts as a profile change on refresh', async () => {
  const f = await fixture();
  const base = await f.save(profile('base', { rules: [literal('c', 'Acme', 'Nova')] }));
  await f.save(profile('child', { extends: ['base'] }));
  await f.sync('push', { profiles: ['child'], files: ['src'], to: f.destination });
  expect(await readFile(join(f.destination, 'src/a.ts'), 'utf8')).toBe('Nova in src\n');
  await f.save({ ...base.profile, rules: [literal('c', 'Acme', 'Orion')] }, base.id);
  const refreshed = await createTestSync(createSyncServices(f.destination, f.store), '2.0.0')(
    'pull',
    {},
  );
  expect(refreshed.status).toBe('written');
  expect(await readFile(join(f.destination, 'src/a.ts'), 'utf8')).toBe('Orion in src\n');
});

it('a missing parent stops the pull with a clear error', async () => {
  const f = await fixture();
  await f.save(profile('child', { extends: ['gone'] }));
  await expect(
    f.sync('push', { profiles: ['child'], files: ['src'], to: f.destination }),
  ).rejects.toThrow(/child extends "gone"/);
});

/** Writes past validation, the way a profile saved before these checks exists on disk. */
async function writeLegacyProfile(
  store: ReturnType<typeof createStore>,
  id: string,
  document: Record<string, unknown>,
) {
  await store.writeSealed(`profiles/${id}.json`, id, 'profile', document);
}
const unsafeLegacy = {
  kind: 'profile',
  schemaVersion: 1,
  name: 'old-unsafe',
  rules: [
    literal('c', 'Acme', 'Nova'),
    { id: 'evil', type: 'regex', match: '(a+)+$', replace: 'x$&' },
  ],
};

it('a saved profile that now fails stays listed, and a pull names the rule', async () => {
  const f = await fixture();
  await writeLegacyProfile(f.store, 'pf_old', unsafeLegacy);
  const listed = await f.services.profiles.list({ kind: 'global' });
  expect(listed.map((saved) => saved.profile.name)).toEqual(['old-unsafe']);
  await expect(
    f.sync('push', { profiles: ['old-unsafe'], files: ['src'], to: f.destination }),
  ).rejects.toThrow(/old-unsafe\/evil: unsafe regex/);
  expect(await exists(f.destination)).toBe(false);
});

it('an existing v1 cloak opens, restores and refreshes without seeing a profile change', async () => {
  const f = await fixture();
  const legacy = {
    kind: 'profile',
    schemaVersion: 1,
    name: 'legacy',
    rules: [literal('c', 'Acme', 'Nova')],
  };
  await writeLegacyProfile(f.store, 'pf_legacy', legacy);
  await f.sync('push', { profiles: ['legacy'], files: ['src'], to: f.destination });
  const snapshot = await f.services.store.readSnapshot(f.destination);
  expect(snapshot?.data.profiles[0]?.hash).toBe(hashJson(legacy));
  const services = createSyncServices(f.destination, f.store);
  await writeFile(join(f.source, 'src', 'a.ts'), 'Acme changed\n');
  const refreshed = await createTestSync(services, '2.0.0')('pull', {});
  expect(refreshed.profileChanges).toEqual([]);
  expect(await readFile(join(f.destination, 'src/a.ts'), 'utf8')).toBe('Nova changed\n');
  await writeFile(join(f.destination, 'src', 'a.ts'), 'Nova edited\n');
  const pushed = await createTestSync(services, '2.0.0')('push', {});
  expect(pushed.status).toBe('written');
  expect(await readFile(join(f.source, 'src/a.ts'), 'utf8')).toBe('Acme edited\n');
});

it('a cloak whose sealed manifest holds a now-refused regex still restores', async () => {
  const f = await fixture();
  // Pull with a harmless profile, then swap the sealed rules for the unsafe ones: exactly what
  // a cloak made before the static check holds.
  await f.save(profile('p', { rules: [literal('c', 'Acme', 'Nova')] }));
  await f.sync('push', { profiles: ['p'], files: ['src'], to: f.destination });
  const snapshot = await f.services.store.readSnapshot(f.destination);
  if (!snapshot) throw new Error('No snapshot');
  const unsafe = { id: 'evil', type: 'regex', match: '(a+)+$', replace: 'x$&' } as const;
  const plan = {
    plain: snapshot.plain,
    data: { ...snapshot.data, rules: [...snapshot.data.rules, unsafe] },
  };
  const manifest = await f.services.store.sealManifest(plan);
  await writeFile(join(f.destination, '.repo-cloak', 'manifest.json'), manifest);
  await writeFile(join(f.destination, 'src', 'a.ts'), 'Nova restored\n');
  const services = createSyncServices(f.destination, f.store);
  const pushed = await createTestSync(services, '2.0.0')('push', {});
  expect(pushed.status).toBe('written');
  expect(await readFile(join(f.source, 'src/a.ts'), 'utf8')).toBe('Acme restored\n');
});

it('a pull stops at the regex timeout, names file and rule, and writes nothing', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'src', 'big.txt'), 'a,'.repeat(4000));
  await f.save(
    profile('slow', {
      rules: [{ id: 'slow', type: 'regex', match: '^(.*?,){14}P', replace: 'x$&' }],
    }),
  );
  await expect(
    f.sync('push', { profiles: ['slow'], files: ['src/big.txt'], to: f.destination }),
  ).rejects.toThrow(/big\.txt: slow: regex did not finish/);
  expect(await exists(f.destination)).toBe(false);
}, 30_000);

it('commit export refuses a file outside the roots, with no override', async () => {
  const f = await fixture();
  const dashboard = createDashboard(f.store, f.source);
  const repoId = (await dashboard.context()).repoId as string;
  await f.save(profile('scoped', { rules: [literal('c', 'Acme', 'Nova')], allowRoots: ['src/'] }));
  await f.sync('push', { profiles: ['scoped'], files: ['src'], to: f.destination });
  const head = (await runGit(f.source, ['rev-parse', 'HEAD'])).trim();
  const workspaceId = (await f.services.store.readSnapshot(f.destination))?.plain
    .workspaceId as string;
  const { files } = await dashboard.sync.exportFiles(repoId, workspaceId, { commit: head });
  const outside = files.find((file) => file.path.includes('top'));
  const inside = files.find((file) => file.path.startsWith('src/'));
  expect(outside?.excluded).toBe(true);
  expect(inside?.excluded).toBe(false);
  await expect(
    dashboard.sync.exportDiff(repoId, workspaceId, {
      commit: head,
      indexes: [outside?.index],
      includeExcluded: true,
    }),
  ).rejects.toThrow(/outside the allowed roots/);
});
