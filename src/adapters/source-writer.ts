import { chmod, lstat, mkdtemp, readFile, rm, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import type { PushPlan } from '../core/push.js';
import { writeAtomic } from './atomic.js';
import { checkDestinationPath, checkSourceDestination, exists } from './files.js';

export type SourceWrite = {
  root: string;
  commonDir: string;
  workspace: string;
  plan: PushPlan;
  manifest: Uint8Array;
  recheck(): Promise<void>;
  afterSave(): Promise<void>;
};

/** Source changes and the workspace baseline roll back together on an ordinary I/O failure. */
export function createSourceWriter(write = writeAtomic) {
  return async (request: SourceWrite): Promise<void> => {
    const releaseWorkspace = await lock(request.workspace, { retries: 0 });
    let releaseSource: (() => Promise<void>) | undefined;
    const backups = new Map<string, { bytes: Uint8Array; mode: number } | undefined>();
    const created = new Set<string>();
    let started = false;
    let completed = false;
    try {
      releaseSource = await lock(request.commonDir, { retries: 0 });
      await request.recheck();
      const manifestPath = join(request.workspace, '.repo-cloak', 'manifest.json');
      const outputs = request.plan.writes.map((file) => ({
        ...file,
        target: join(request.root, ...file.path.split('/')),
      }));
      const affected = [
        ...new Set([...request.plan.deletes, ...request.plan.writes.map((file) => file.path)]),
      ];
      for (const path of affected) {
        await checkSourceDestination(request.root, path);
        const target = join(request.root, ...path.split('/'));
        if (await exists(target)) {
          const info = await lstat(target);
          if (!info.isFile()) throw new Error(`${path}: source destination is not a regular file`);
          backups.set(target, { bytes: await readFile(target), mode: info.mode & 0o777 });
        } else backups.set(target, undefined);
      }
      await checkDestinationPath(request.workspace, '.repo-cloak/manifest.json');
      const manifestInfo = await lstat(manifestPath);
      backups.set(manifestPath, {
        bytes: await readFile(manifestPath),
        mode: manifestInfo.mode & 0o777,
      });
      for (const file of outputs) {
        let directory = dirname(file.target);
        while (directory !== request.root && !(await exists(directory))) {
          created.add(directory);
          directory = dirname(directory);
        }
      }
      started = true;
      for (const path of request.plan.deletes) await unlink(join(request.root, ...path.split('/')));
      for (const file of outputs) {
        await checkSourceDestination(request.root, file.path);
        await write(file.target, file.bytes);
        if (process.platform !== 'win32') {
          const mode = backups.get(file.target)?.mode ?? 0o644;
          await chmod(file.target, file.executable ? mode | 0o100 : mode & ~0o111);
        }
      }
      await write(manifestPath, request.manifest);
      completed = true;
      await request.afterSave();
    } catch (error) {
      if (completed)
        throw new Error(
          'Source files and workspace baseline were saved, but updating the local store failed; retry to repair its record',
          { cause: error },
        );
      if (started) {
        const failures: unknown[] = [];
        for (const [target, previous] of backups) {
          try {
            if (previous) {
              await writeAtomic(target, previous.bytes);
              if (process.platform !== 'win32') await chmod(target, previous.mode);
            } else await rm(target, { force: true });
          } catch (failure) {
            failures.push(failure);
          }
        }
        if (failures.length) {
          const recovery = await mkdtemp(join(tmpdir(), 'repo-cloak-recovery-'));
          if (process.platform !== 'win32') await chmod(recovery, 0o700);
          const index: { target: string; backup: string | null; mode: number | undefined }[] = [];
          for (const [target, previous] of backups) {
            const name = `file-${index.length}`;
            if (previous) await writeAtomic(join(recovery, name), previous.bytes);
            index.push({ target, backup: previous ? name : null, mode: previous?.mode });
          }
          await writeAtomic(join(recovery, 'index.json'), JSON.stringify(index, null, 2));
          throw new AggregateError(
            [error, ...failures],
            `Restore rollback failed; recovery copies remain in ${recovery}`,
            { cause: error },
          );
        }
      }
      throw error;
    } finally {
      for (const directory of [...created].sort((a, b) => b.length - a.length))
        await rmdir(directory).catch(() => {});
      try {
        await releaseSource?.();
      } finally {
        await releaseWorkspace();
      }
    }
  };
}
