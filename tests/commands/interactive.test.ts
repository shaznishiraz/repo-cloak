import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createStore } from '../../src/adapters/store.js';
import { runGit } from '../../src/adapters/git.js';
import { runInteractive } from '../../src/commands/interactive.js';
import type { InteractiveIO } from '../../src/commands/interactive.js';
import { listWorkspaces } from '../../src/commands/workspaces.js';
import { validateProfile } from '../../src/core/rules.js';
import { createProgram } from '../../src/program.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak interactive ')));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(source);
  await runGit(source, ['init', '-b', 'main']);
  await writeFile(join(source, 'Acme.ts'), 'class Acme {}');
  const store = createStore(join(root, 'store'));
  const services = createSyncServices(source, store);
  services.interactive = true;
  services.confirmPull = async () => true;
  services.confirmPush = async () => true;
  services.workspacesRoot = async () => join(root, 'workspaces');
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  const profile = await services.profiles.save(
    { kind: 'global' },
    validateProfile({
      kind: 'profile',
      schemaVersion: 1,
      name: 'acme',
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    }),
  );
  const io: InteractiveIO = {
    services,
    action: async () => 'new',
    profiles: async () => ({ selected: [profile], create: false }),
    createProfile: async () => {
      throw new Error('unexpected profile creation');
    },
    selection: async () => ({ files: ['Acme.ts'] }),
    status: async () => ({ added: [], modified: [], deleted: [] }),
    write: vi.fn(),
    ui: vi.fn(async () => {}),
  };
  return { root, source, store, services, profile, io };
}

it('registers a new source before setup and creates an anonymized workspace through the bare CLI', async () => {
  const { io, services } = await fixture();
  io.action = async (side, known) => {
    expect(side).toBe('source');
    expect(known).toBe(false);
    const repo = await services.git.repoState(services.cwd);
    expect((await services.store.readRepo(repo.repoId))?.workspaces).toEqual({});
    return 'new';
  };
  await createProgram(undefined, undefined, undefined, async () => io).parseAsync([], {
    from: 'user',
  });
  const workspaces = await listWorkspaces(services);
  expect(workspaces).toHaveLength(1);
  const workspace = workspaces[0]?.path ?? '';
  expect(await readFile(join(workspace, 'Northwind.ts'), 'utf8')).toBe('class Northwind {}');
  expect(io.write).toHaveBeenCalledWith(expect.stringContaining('written: 1 files'));
});

it('suggests saved profile ids on refresh and creates a separate workspace when asked', async () => {
  const { io, profile, services } = await fixture();
  await runInteractive(io, '2.0.0');
  const first = (await listWorkspaces(services))[0]?.path ?? '';
  io.action = async (side, known) => {
    expect(side).toBe('source');
    expect(known).toBe(true);
    return 'extract';
  };
  io.profiles = async (_available, suggested) => {
    expect(suggested).toEqual([profile.id]);
    return { selected: [profile], create: false };
  };
  await runInteractive(io, '2.0.0');
  io.action = async () => 'new';
  io.profiles = async () => ({ selected: [profile], create: false });
  await runInteractive(io, '2.0.0');
  const paths = (await listWorkspaces(services)).map((workspace) => workspace.path);
  expect(paths).toHaveLength(2);
  expect(paths).toContain(first);
});

it('allows creating a profile during setup and validates combined choices', async () => {
  const { io, services, profile } = await fixture();
  let attempts = 0;
  io.profiles = async (_available, suggested) => {
    if (attempts++ === 0) return { selected: [], create: true };
    expect(suggested).toContain(profile.id);
    return { selected: [profile], create: false };
  };
  io.createProfile = vi.fn(async () => profile);
  await runInteractive(io, '2.0.0');
  expect(io.createProfile).toHaveBeenCalledWith(
    (await services.git.repoState(services.cwd)).repoId,
  );
  expect(attempts).toBe(2);
});

it('offers workspace actions and routes restore and status from a nested directory', async () => {
  const { io, source, services } = await fixture();
  await runInteractive(io, '2.0.0');
  const workspace = (await listWorkspaces(services))[0]?.path ?? '';
  await mkdir(join(workspace, 'nested'));
  services.cwd = join(workspace, 'nested');
  io.action = async (side) => {
    expect(side).toBe('workspace');
    return 'restore';
  };
  await writeFile(join(workspace, 'Northwind.ts'), 'class Northwind { edited = true }');
  await runInteractive(io, '2.0.0');
  expect(await readFile(join(source, 'Acme.ts'), 'utf8')).toBe('class Acme { edited = true }');
  io.action = async () => 'status';
  io.status = vi.fn(async () => ({ modified: [] }));
  await runInteractive(io, '2.0.0');
  expect(io.status).toHaveBeenCalledWith(workspace);
});

it('rejects non-interactive use before registering a repository or asking questions', async () => {
  const { io, services } = await fixture();
  services.interactive = false;
  io.action = vi.fn(io.action);
  services.store.registerRepo = vi.fn(services.store.registerRepo);
  await expect(runInteractive(io, '2.0.0')).rejects.toThrow('needs a terminal');
  expect(services.store.registerRepo).not.toHaveBeenCalled();
  expect(io.action).not.toHaveBeenCalled();
});

it('ranks the current branch workspace before more recently used branches', async () => {
  const { io, services } = await fixture();
  await runInteractive(io, '2.0.0');
  const first = (await listWorkspaces(services))[0]?.path ?? '';
  await runGit(services.cwd, ['symbolic-ref', 'HEAD', 'refs/heads/other']);
  await runInteractive(io, '2.0.0');
  await runGit(services.cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  io.action = async () => 'extract';
  services.chooseWorkspace = async (paths) => {
    expect(paths[0]).toBe(first);
    return first;
  };
  await runInteractive(io, '2.0.0');
});

it('refreshes recorded paths even when their source file has been deleted', async () => {
  const { io, services, source } = await fixture();
  await runInteractive(io, '2.0.0');
  const workspace = (await listWorkspaces(services))[0]?.path ?? '';
  await rm(join(source, 'Acme.ts'));
  io.action = async () => 'extract';
  io.selection = async (_repo, _profiles, tracked) => {
    expect(tracked).toEqual(['Acme.ts']);
    return { includeTracked: true };
  };
  await runInteractive(io, '2.0.0');
  await expect(readFile(join(workspace, 'Northwind.ts'))).rejects.toThrow();
});

it('opens the dashboard directly from the guided menu', async () => {
  const { io } = await fixture();
  io.action = async () => 'ui';
  await runInteractive(io, '2.0.0');
  expect(io.ui).toHaveBeenCalledOnce();
});
