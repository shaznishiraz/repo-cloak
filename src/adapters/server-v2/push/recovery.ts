import { chmod, readdir, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { hashJson } from '../../../core/hash.js';
import { validateRelativePath } from '../../../core/paths.js';
import { classifyInterrupted } from '../../../core/push-recovery.js';
import type { Dashboard } from '../../../application/dashboard.js';
import type { GuardCheck } from '../../../web/api/contracts.js';
import { errorCode, writeAtomic } from '../../atomic.js';
import { checkSourceDestination } from '../../files.js';
import { runGit } from '../../git.js';
import { OperationError } from '../../ui-operations.js';
import { backupRoot, commonDirOf, readBytes } from './backup-parts.js';
import type { Vault } from './backup-parts.js';
import { withLocks } from './backups.js';
import { fileHashes, finishBackup, journalIds, manifestHashes, readJournal } from './journal.js';
import type { Journal } from './journal.js';
import { noticesFor } from './state.js';

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Restores pre-images. Called only when every file is at `before` or `after`, under the locks. */
async function rollBack(vault: Vault, directory: string, journal: Journal) {
  for (const file of journal.files) {
    const path = validateRelativePath(file.path);
    await checkSourceDestination(journal.root, path);
    const target = join(journal.root, ...path.split('/'));
    if (file.blob) {
      await writeAtomic(target, await readBytes(vault, directory, journal.id, file.blob));
      if (file.mode !== null && process.platform !== 'win32') await chmod(target, file.mode);
    } else
      await unlink(target).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
  }
  await rm(directory, { recursive: true, force: true });
}
/** The commit that follows the manifest write can stop between `add` and `commit`. */
async function unstage(journal: Journal) {
  await runGit(journal.workspace, [
    '--literal-pathspecs',
    'reset',
    '-q',
    '--',
    ...journal.checkpoint,
  ]).catch(() => {});
}
/** A killed `writeAtomic` strands its temporary, which holds real bytes, beside the target. */
async function removeTemporaries(journal: Journal) {
  const folders = new Set([
    join(journal.workspace, '.repo-cloak'),
    ...journal.files.map((file) => dirname(join(journal.root, ...file.path.split('/')))),
  ]);
  for (const folder of folders)
    for (const name of await readdir(folder).catch(() => [] as string[]))
      if (/^\.cloak-[0-9a-f-]+\.tmp$/.test(name)) await rm(join(folder, name), { force: true });
}
async function settle(vault: Vault, directory: string, journal: Journal) {
  const id = `recovery:${journal.id}`;
  await removeTemporaries(journal);
  const manifest = await manifestHashes(vault, journal);
  const files = await fileHashes(journal);
  const state = classifyInterrupted(manifest, files);
  if (journal.newTree) {
    await rm(directory, { recursive: true, force: true });
    if (state === 'landed') {
      await unstage(journal);
      return {
        outcome: 'ok' as const,
        check: {
          id,
          state: 'warning' as const,
          title: 'An interrupted push had landed',
          detail: `Its files are in ${journal.root}. Staging, commit or re-pull may not have run.`,
        },
      };
    }
    return {
      outcome: 'failed' as const,
      check: {
        id,
        state: 'warning' as const,
        title: 'An interrupted push left a worktree behind',
        detail: `Nothing landed and your cloak edits are still pending. Remove ${journal.root} and its branch if you do not want them.`,
      },
    };
  }
  switch (state) {
    case 'nothing':
      await rm(directory, { recursive: true, force: true });
      return {
        outcome: 'failed' as const,
        check: {
          id,
          state: 'info' as const,
          title: 'An interrupted push changed nothing',
          detail: 'Your cloak edits are still pending.',
        },
      };
    case 'partial':
      await rollBack(vault, directory, journal);
      return {
        outcome: 'failed' as const,
        check: {
          id,
          state: 'warning' as const,
          title: 'An interrupted push was rolled back',
          detail: `${plural(journal.files.length, 'source file')} put back as they were. Your cloak edits are still pending.`,
        },
      };
    case 'landed':
      await unstage(journal);
      await finishBackup(vault, directory, journal);
      return {
        outcome: 'ok' as const,
        check: {
          id,
          state: 'warning' as const,
          title: 'An interrupted push had landed',
          detail:
            journal.mode === 'write'
              ? 'Its files are in place and undo is available. A re-pull may not have run.'
              : 'Its files are in place and undo is available. Staging, commit or re-pull may not have run, so check the target.',
        },
      };
    case 'foreign': {
      const changed = journal.files.filter(
        (file, at) => files[at]?.current !== file.before && files[at]?.current !== file.after,
      );
      await finishBackup(
        vault,
        directory,
        journal,
        files.map((file) => (file.current === 'unreadable' ? null : file.current)),
      );
      return {
        outcome: 'failed' as const,
        check: {
          id,
          state: 'warning' as const,
          title: 'An interrupted push needs your attention',
          detail: `${
            changed.length
              ? `${changed.map((file) => basename(file.path)).join(', ')} changed afterwards`
              : 'The manifest changed afterwards'
          }, so nothing was rolled back. The earlier copies are kept as a backup for 7 days: undo restores them.`,
        },
      };
    }
  }
}

/**
 * Accounts for any push that stopped before finishing, and returns what the review should say.
 * Holding the operation lock and both file locks means no live push can be writing the same files.
 */
export async function recoverInterrupted(
  dashboard: Dashboard,
  repoId: string,
  workspaceId: string,
): Promise<GuardCheck[]> {
  const commonDir = await commonDirOf(dashboard, repoId);
  const notices = noticesFor(dashboard);
  if ((await journalIds(commonDir, workspaceId)).length) {
    // A key that cannot be loaded at all must fail here, before a journal is called unreadable.
    const vault = await dashboard.sync.vault();
    const { path: workspace } = await dashboard.sync.workspaceTarget(repoId, workspaceId);
    const { base, relative } = backupRoot(commonDir, workspaceId);
    const audit = {
      op: 'push' as const,
      workspace: { repoId, id: workspaceId, name: basename(workspace) },
    };
    try {
      await dashboard.sync.operations.exclusive(() =>
        withLocks(workspace, commonDir, async () => {
          for (const id of await journalIds(commonDir, workspaceId)) {
            const directory = join(base, relative, id);
            const found = notices.get(workspaceId) ?? [];
            let journal: Journal;
            try {
              journal = await readJournal(vault, directory, id);
              if (journal.id !== id || journal.workspaceId !== workspaceId)
                throw new Error('This journal belongs elsewhere');
            } catch {
              await rename(join(directory, 'journal.json'), join(directory, 'journal.unreadable'));
              await dashboard.sync.audit.record({
                ...audit,
                outcome: 'failed',
                detail: 'Interrupted push could not be read',
              });
              notices.set(workspaceId, [
                ...found,
                {
                  id: `recovery:${hashJson(id).slice(7, 19)}`,
                  state: 'warning',
                  title: 'An interrupted push could not be read',
                  detail:
                    'Its record is damaged or sealed under a lost key, so nothing was rolled back. Check the target by hand.',
                },
              ]);
              continue;
            }
            const { outcome, check } = await settle(vault, directory, journal);
            await dashboard.sync.audit.record({
              ...audit,
              outcome,
              detail: `Recovery: ${check.title}`,
            });
            notices.set(workspaceId, [...found, check]);
          }
        }),
      );
    } catch (error) {
      const busy =
        errorCode(error) === 'ELOCKED' ||
        (error instanceof OperationError && error.code === 'busy');
      return [
        ...(notices.get(workspaceId) ?? []),
        {
          id: 'recovery:pending',
          state: 'blocked',
          title: busy
            ? 'Another push is running, or one just stopped'
            : 'An interrupted push could not be recovered',
          detail: busy
            ? 'Wait a few seconds and review again. Nothing was changed.'
            : `${error instanceof Error ? error.message : 'Recovery failed'}. Its record is kept, so the next review tries again.`,
        },
      ];
    }
  }
  return notices.get(workspaceId) ?? [];
}
