import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { hashBytes } from '../../../core/hash.js';
import { classifyInterrupted } from '../../../core/push-recovery.js';
import type { Dashboard } from '../../../application/dashboard.js';
import { checkDestinationPath, checkSourceDestination, exists } from '../../files.js';
import type { PushSelection } from '../../ui-operations.js';
import {
  backupDays,
  backupIdSchema,
  backupRoot,
  commonDirOf,
  dayMs,
  encodeBytes,
  manifestFingerprint,
  openManifest,
  readPart,
  writePart,
} from './backup-parts.js';
import type { BackupIndex, Vault } from './backup-parts.js';

const journalSchema = z.object({
  id: backupIdSchema,
  repoId: z.string().min(1),
  workspaceId: z.string().min(1),
  workspace: z.string().min(1),
  root: z.string().min(1),
  createdAt: z.string(),
  mode: z.enum(['write', 'stage', 'commit']),
  newTree: z.boolean(),
  manifestBefore: z.string(),
  manifestAfter: z.string(),
  /** Workspace paths the commit would stage; a crash can leave them in its index. */
  checkpoint: z.array(z.string()),
  files: z.array(
    z.object({
      path: z.string().min(1),
      blob: z
        .string()
        .regex(/^f\d+$/)
        .nullable(),
      mode: z.number().int().nullable(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    }),
  ),
});
export type Journal = z.infer<typeof journalSchema>;

export type BackupContext = {
  repoId: string;
  workspaceId: string;
  workspace: string;
  root: string;
  newTree: boolean;
  mode: Journal['mode'];
};
type Changes = Parameters<NonNullable<PushSelection['beforeWrite']>>[1];

/**
 * One push's backup and write-ahead journal. `begin` runs under the writer's locks just before the
 * first file changes; the journal is written last, so one on disk has everything recovery needs.
 */
export function createBackupSession(dashboard: Dashboard, context: BackupContext) {
  const id = randomUUID();
  let journal: Journal | undefined;
  const placeOf = async () => {
    const commonDir = await commonDirOf(dashboard, context.repoId);
    const { base, relative } = backupRoot(commonDir, context.workspaceId);
    return { base, relative, directory: join(base, relative, id) };
  };
  const discard = async () => rm((await placeOf()).directory, { recursive: true, force: true });
  return {
    id,
    discard,
    async begin(manifest: Uint8Array, changes: Changes) {
      const vault = await dashboard.sync.vault();
      const { base, relative, directory } = await placeOf();
      await checkDestinationPath(base, `${relative}/${id}`);
      const after = new Map<string, string | null>(changes.deletes.map((path) => [path, null]));
      for (const file of changes.writes) after.set(file.path, hashBytes(file.bytes));
      const files: Journal['files'] = [];
      for (const [index, [path, hash]] of [...after].entries()) {
        const target = join(context.root, ...path.split('/'));
        if (!context.newTree) await checkSourceDestination(context.root, path);
        if (!context.newTree && (await exists(target))) {
          const bytes = await readFile(target);
          await writePart(vault, directory, id, `f${index}`, encodeBytes(bytes));
          files.push({
            path,
            blob: `f${index}`,
            mode: (await lstat(target)).mode & 0o777,
            before: hashBytes(bytes),
            after: hash,
          });
        } else files.push({ path, blob: null, mode: null, before: null, after: hash });
      }
      await checkDestinationPath(context.workspace, '.repo-cloak/manifest.json');
      const current = await readFile(join(context.workspace, '.repo-cloak', 'manifest.json'));
      await writePart(vault, directory, id, 'manifest', openManifest(vault, current));
      const entry: Journal = {
        id,
        repoId: context.repoId,
        workspaceId: context.workspaceId,
        workspace: context.workspace,
        root: context.root,
        createdAt: new Date().toISOString(),
        mode: context.mode,
        newTree: context.newTree,
        manifestBefore: manifestFingerprint(vault, current),
        manifestAfter: manifestFingerprint(vault, manifest),
        checkpoint: changes.checkpoint,
        files,
      };
      await writePart(vault, directory, id, 'journal', entry);
      journal = entry;
    },
    /** The push is over: from here its files can be undone, and nothing needs recovering. */
    async finish() {
      if (!journal) return;
      const vault = await dashboard.sync.vault();
      await finishBackup(vault, (await placeOf()).directory, journal);
    },
    /** After a failed write: drop what changed nothing, keep undo for what landed, else recover. */
    async settle() {
      if (!journal) return discard();
      const vault = await dashboard.sync.vault();
      const state = classifyInterrupted(
        await manifestHashes(vault, journal),
        await fileHashes(journal),
      );
      if (state === 'nothing') await discard();
      else if (state === 'landed') await finishBackup(vault, (await placeOf()).directory, journal);
    },
  };
}
export type BackupSession = ReturnType<typeof createBackupSession>;

export async function hashOnDisk(root: string, path: string) {
  await checkSourceDestination(root, path);
  const target = join(root, ...path.split('/'));
  return (await exists(target)) ? hashBytes(await readFile(target)) : null;
}
/** A file that cannot be examined counts as changed: nothing is decided from a guess. */
export function fileHashes(journal: Journal) {
  return Promise.all(
    journal.files.map(async (file) => ({
      before: file.before,
      after: file.after,
      current: await hashOnDisk(journal.root, file.path).catch(() => 'unreadable'),
    })),
  );
}
export async function manifestHashes(vault: Vault, journal: Journal) {
  const bytes = await readFile(join(journal.workspace, '.repo-cloak', 'manifest.json'));
  return {
    before: journal.manifestBefore,
    after: journal.manifestAfter,
    current: manifestFingerprint(vault, bytes),
  };
}
/** Index first, journal second: finding both means this already finished. */
export async function finishBackup(
  vault: Vault,
  directory: string,
  journal: Journal,
  currentHashes?: (string | null)[],
) {
  if (journal.newTree || !journal.files.length) {
    await rm(directory, { recursive: true, force: true });
    return;
  }
  const createdAt = new Date(journal.createdAt);
  const manifest = await readFile(join(journal.workspace, '.repo-cloak', 'manifest.json'));
  const index: BackupIndex = {
    id: journal.id,
    workspaceId: journal.workspaceId,
    root: journal.root,
    createdAt: journal.createdAt,
    expiresAt: new Date(createdAt.getTime() + backupDays * dayMs).toISOString(),
    manifestAfter: manifestFingerprint(vault, manifest),
    manifestBefore: journal.manifestBefore,
    files: journal.files.map(({ path, blob, mode, before, after }, at) => ({
      path,
      blob,
      mode,
      before,
      after: currentHashes ? (currentHashes[at] ?? null) : after,
    })),
  };
  await writePart(vault, directory, journal.id, 'index', index);
  await rm(join(directory, 'journal.json'), { force: true });
}
export async function readJournal(vault: Vault, directory: string, id: string) {
  return journalSchema.parse(await readPart(vault, directory, id, 'journal'));
}
/** Backups in this workspace with a journal on disk, whichever process wrote it. */
export async function journalIds(commonDir: string, workspaceId: string) {
  const { base, relative } = backupRoot(commonDir, workspaceId);
  const parent = join(base, relative);
  const names = await readdir(parent).catch(() => [] as string[]);
  const found = await Promise.all(
    names.map(async (name) =>
      (await exists(join(parent, name, 'journal.json'))) ? name : undefined,
    ),
  );
  return found.filter((name) => name !== undefined);
}
