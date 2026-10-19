import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSourceWriter } from '../../src/adapters/source-writer.js';
import type { SourceWrite } from '../../src/adapters/source-writer.js';
import { writeAtomic } from '../../src/adapters/atomic.js';
import { planPull } from '../../src/core/pull.js';
import type { SourceFile } from '../../src/core/pull.js';
import { planPush } from '../../src/core/push.js';

const fault = vi.hoisted(() => ({ path: '' }));
vi.mock('../../src/adapters/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/atomic.js')>();
  return {
    ...actual,
    async writeAtomic(path: string, bytes: string | Uint8Array) {
      if (path === fault.path) throw new Error('Recovery write failed');
      await actual.writeAtomic(path, bytes);
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  fault.path = '';
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});
function file(path: string, text: string): SourceFile {
  return { path, text, bytes: Buffer.from(text), binary: false, executable: false };
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak source writer ')));
  roots.push(root);
  const source = join(root, 'source');
  const workspace = join(root, 'workspace');
  const commonDir = join(root, 'git-common');
  await Promise.all([
    mkdir(source),
    mkdir(join(workspace, '.repo-cloak'), { recursive: true }),
    mkdir(commonDir),
  ]);
  const files = [file('one.txt', 'one before'), file('two.txt', 'two before')];
  for (const file of files) await writeFile(join(source, file.path), file.bytes ?? '');
  if (process.platform !== 'win32') await chmod(join(source, 'one.txt'), 0o640);
  const manifestPath = join(workspace, '.repo-cloak', 'manifest.json');
  await writeFile(manifestPath, 'manifest before');
  const snapshot = planPull({
    repo: { repoId: '0123456789abcdef', path: source, branch: 'main', commit: null },
    workspaceId: 'test',
    pullId: 'p_test',
    at: '2026-10-17T00:00:00Z',
    version: '2.0.0',
    profiles: [],
    files,
    workspace: {},
    selection: { files: 2, commits: 0, working: false, extra: 0 },
  });
  const plan = planPush(
    snapshot,
    [file('one.txt', 'one after'), file('two.txt', 'two after')],
    files,
  );
  const request: SourceWrite = {
    root: source,
    workspace,
    commonDir,
    plan,
    manifest: Buffer.from('manifest after'),
    recheck: async () => {},
    afterSave: vi.fn(async () => {}),
  };
  return { root, source, workspace, manifestPath, request };
}

it('rolls back earlier writes and permissions when a later source write fails', async () => {
  const { source, manifestPath, request, root } = await fixture();
  const save = createSourceWriter(async (path, bytes) => {
    if (path === join(source, 'two.txt')) throw new Error('Second write failed');
    await writeAtomic(path, bytes);
  });
  await expect(save(request)).rejects.toThrow('Second write failed');
  expect(await readFile(join(source, 'one.txt'), 'utf8')).toBe('one before');
  expect(await readFile(join(source, 'two.txt'), 'utf8')).toBe('two before');
  expect(await readFile(manifestPath, 'utf8')).toBe('manifest before');
  if (process.platform !== 'win32')
    expect((await stat(join(source, 'one.txt'))).mode & 0o777).toBe(0o640);
  expect(request.afterSave).not.toHaveBeenCalled();
  expect((await readdir(root)).some((path) => path.endsWith('.lock'))).toBe(false);
});

it('keeps successfully restored files and baseline when the private record save fails', async () => {
  const { source, manifestPath, request } = await fixture();
  request.afterSave = async () => {
    throw new Error('Store unavailable');
  };
  await expect(createSourceWriter()(request)).rejects.toThrow(/were saved.*local store/);
  expect(await readFile(join(source, 'one.txt'), 'utf8')).toBe('one after');
  expect(await readFile(join(source, 'two.txt'), 'utf8')).toBe('two after');
  expect(await readFile(manifestPath, 'utf8')).toBe('manifest after');
});

it('preserves private recovery copies and reports both errors if rollback also fails', async () => {
  const { source, manifestPath, request } = await fixture();
  const save = createSourceWriter(async (path, bytes) => {
    if (path === manifestPath) {
      fault.path = join(source, 'one.txt');
      throw new Error('Manifest write failed');
    }
    await writeAtomic(path, bytes);
  });
  const error: unknown = await save(request).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) throw new Error('Expected recovery failure');
  expect(error.errors.map((error: Error) => error.message)).toEqual([
    'Manifest write failed',
    'Recovery write failed',
  ]);
  const recovery = /recovery copies remain in (.+)$/.exec(error.message)?.[1];
  if (!recovery) throw new Error('Missing recovery directory');
  roots.push(recovery);
  const index = JSON.parse(await readFile(join(recovery, 'index.json'), 'utf8')) as {
    target: string;
    backup: string | null;
  }[];
  const backup = index.find((entry) => entry.target === join(source, 'one.txt'))?.backup;
  if (!backup) throw new Error('Missing source backup');
  expect(await readFile(join(recovery, backup), 'utf8')).toBe('one before');
  expect(await readFile(manifestPath, 'utf8')).toBe('manifest before');
  expect(request.afterSave).not.toHaveBeenCalled();
  if (process.platform !== 'win32') {
    expect((await stat(recovery)).mode & 0o777).toBe(0o700);
    expect((await stat(join(recovery, backup))).mode & 0o777).toBe(0o600);
  }
});

it('restores deleted files and removes newly created files and folders when a later write fails', async () => {
  const { source, manifestPath, request } = await fixture();
  request.plan.deletes = ['one.txt'];
  request.plan.writes = [
    { path: 'new/created.txt', bytes: Buffer.from('new file'), executable: false },
    { path: 'two.txt', bytes: Buffer.from('two after'), executable: false },
  ];
  const save = createSourceWriter(async (path, bytes) => {
    if (path === join(source, 'two.txt')) throw new Error('Write after deletion failed');
    await writeAtomic(path, bytes);
  });
  await expect(save(request)).rejects.toThrow('Write after deletion failed');
  expect(await readFile(join(source, 'one.txt'), 'utf8')).toBe('one before');
  expect(await readFile(join(source, 'two.txt'), 'utf8')).toBe('two before');
  expect(await readdir(source)).toEqual(['one.txt', 'two.txt']);
  expect(await readFile(manifestPath, 'utf8')).toBe('manifest before');
});
