import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { hashBytes } from '../core/hash.js';
import type { PullPlan } from '../core/pull.js';
import { errorCode, writeAtomic } from './atomic.js';
import { checkDestinationPath, exists } from './files.js';
import { commitWorkspace, prepareWorkspaceGit, resetWorkspaceIndex } from './workspace-git.js';

export type WorkspaceWrite = {
  root: string;
  plan: PullPlan;
  manifest: Uint8Array;
  initGit: boolean;
  expected: Record<string, Uint8Array>;
  expectedManifest: Uint8Array | undefined;
  recheck(): Promise<void>;
  afterSave?(): Promise<void>;
};

export function createWorkspaceWriter(write = writeAtomic) {
  return async function saveWorkspace(request: WorkspaceWrite): Promise<void> {
    const { root, plan, manifest } = request;
    const fresh = !(await exists(root));
    await mkdir(root, { recursive: true, mode: 0o700 });
    const release = await lock(root, { retries: 0 });
    let stage = '';
    const affected = [
      ...new Set([
        ...plan.deletes,
        ...plan.writes.map((file) => file.path),
        '.repo-cloak/manifest.json',
      ]),
    ];
    const output = [
      ...plan.writes,
      { path: '.repo-cloak/manifest.json', bytes: manifest, executable: false },
    ];
    const backups = new Map<string, { bytes: Uint8Array; mode: number }>();
    const created = new Set<string>();
    let started = false;
    let completed = false;
    let initializedGit = false;
    let preserveStage = false;
    try {
      stage = await mkdtemp(join(tmpdir(), 'repo-cloak-'));
      await request.recheck();
      await checkDestinationPath(root, '.repo-cloak/manifest.json');
      const manifestPath = join(root, '.repo-cloak', 'manifest.json');
      const currentManifest = (await exists(manifestPath))
        ? await readFile(manifestPath)
        : undefined;
      if (
        currentManifest
          ? !request.expectedManifest ||
            hashBytes(currentManifest) !== hashBytes(request.expectedManifest)
          : request.expectedManifest !== undefined
      )
        throw new Error('Workspace manifest changed while preparing the pull');
      if (!currentManifest && (await readdir(root)).length)
        throw new Error('A new workspace destination must be empty');
      for (const path of affected) {
        await checkDestinationPath(root, path);
        const file = join(root, ...path.split('/'));
        if (await exists(file)) {
          const info = await lstat(file);
          const bytes = await readFile(file);
          const expected =
            path === '.repo-cloak/manifest.json'
              ? request.expectedManifest
              : request.expected[path];
          if (!info.isFile() || !expected || hashBytes(bytes) !== hashBytes(expected))
            throw new Error(`${path}: workspace changed while preparing the pull`);
          backups.set(path, { bytes, mode: info.mode & 0o777 });
        } else if (request.expected[path])
          throw new Error(`${path}: workspace file disappeared while preparing the pull`);
      }
      for (let i = 0; i < affected.length; i++) {
        const path = affected[i];
        const backup = path ? backups.get(path) : undefined;
        if (backup) await writeAtomic(join(stage, `backup-${i}`), backup.bytes);
      }
      for (let i = 0; i < output.length; i++)
        await writeAtomic(join(stage, `next-${i}`), output[i]?.bytes ?? new Uint8Array());
      if (request.initGit) initializedGit = await prepareWorkspaceGit(root, affected);
      started = true;
      for (const path of plan.deletes) {
        const file = join(root, ...path.split('/'));
        if (await exists(file)) await unlink(file);
      }
      for (const [index, file] of output.entries()) {
        let directory = dirname(join(root, ...file.path.split('/')));
        while (directory !== root && !(await exists(directory))) {
          created.add(directory);
          directory = dirname(directory);
        }
        await checkDestinationPath(root, file.path);
        const target = join(root, ...file.path.split('/'));
        await write(target, await readFile(join(stage, `next-${index}`)));
        if (process.platform !== 'win32' && file.executable) await chmod(target, 0o700);
      }
      if (request.initGit) await commitWorkspace(root, affected);
      completed = true;
      await request.afterSave?.();
    } catch (error) {
      if (completed)
        throw new Error(
          'Workspace was saved, but updating the local store failed; retry to repair its record',
          { cause: error },
        );
      if (started) {
        const failures: unknown[] = [];
        for (const path of affected) {
          try {
            const target = join(root, ...path.split('/'));
            const previous = backups.get(path);
            if (previous) {
              await writeAtomic(target, previous.bytes);
              if (process.platform !== 'win32') await chmod(target, previous.mode);
            } else
              await unlink(target).catch((error) => {
                if (errorCode(error) !== 'ENOENT') throw error;
              });
          } catch (failure) {
            failures.push(failure);
          }
        }
        try {
          if (initializedGit) await rm(join(root, '.git'), { recursive: true, force: true });
          else if (request.initGit) await resetWorkspaceIndex(root, affected);
        } catch (failure) {
          failures.push(failure);
        }
        if (failures.length) {
          preserveStage = true;
          throw new AggregateError(
            [error, ...failures],
            `Workspace rollback failed; recovery copies remain in ${stage}`,
            { cause: error },
          );
        }
      }
      throw error;
    } finally {
      if (stage && !preserveStage) await rm(stage, { recursive: true, force: true });
      for (const directory of [...created].sort((a, b) => b.length - a.length))
        await rmdir(directory).catch(() => {});
      await release();
      if (fresh) await rmdir(root).catch(() => {});
    }
  };
}
