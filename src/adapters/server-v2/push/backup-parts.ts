import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { hashJson } from '../../../core/hash.js';
import type { Dashboard } from '../../../application/dashboard.js';
import { writeAtomic } from '../../atomic.js';
import { resolveRepo } from '../../git.js';
import { OperationError } from '../../ui-operations.js';

export const dayMs = 24 * 60 * 60 * 1000;
export const backupDays = 7;
export const backupIdSchema = z.string().uuid();
export const backupIndexSchema = z.object({
  id: backupIdSchema,
  workspaceId: z.string().min(1),
  root: z.string().min(1),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** The manifest the push left behind. Undo is refused once anything has moved it on. */
  manifestAfter: z.string(),
  files: z.array(
    z.object({
      path: z.string().min(1),
      blob: z
        .string()
        .regex(/^f\d+$/)
        .nullable(),
      mode: z.number().int().nullable(),
      after: z.string().nullable(),
      /** Absent on a backup from before sealing. */
      before: z.string().nullable().optional(),
    }),
  ),
  manifestBefore: z.string().optional(),
});
export type BackupIndex = z.infer<typeof backupIndexSchema>;
export type Vault = Awaited<ReturnType<Dashboard['sync']['vault']>>;

/* ---------- Sealed parts ---------- */
const partName = /^[a-z]+\d*$/;
const authenticated = (backupId: string, part: string) => ({
  kind: 'push-backup',
  backupId,
  part,
});
/** The shape key rotation reseals. The AAD ties each part to one place in one backup. */
export async function writePart(
  vault: Vault,
  directory: string,
  backupId: string,
  part: string,
  value: unknown,
) {
  if (!partName.test(part)) throw new Error('Invalid backup part');
  const plain = authenticated(backupId, part);
  await writeAtomic(
    join(directory, `${part}.json`),
    JSON.stringify({ ...plain, sealed: vault.seal(value, plain) }),
  );
}
export async function readPart(vault: Vault, directory: string, backupId: string, part: string) {
  if (!partName.test(part)) throw new Error('Invalid backup part');
  const { sealed } = JSON.parse(await readFile(join(directory, `${part}.json`), 'utf8')) as {
    sealed?: unknown;
  };
  return vault.open(sealed, authenticated(backupId, part));
}
export const encodeBytes = (bytes: Uint8Array) => ({ data: Buffer.from(bytes).toString('base64') });
const bytesSchema = z.object({ data: z.string() });
export async function readBytes(vault: Vault, directory: string, backupId: string, part: string) {
  const { data } = bytesSchema.parse(await readPart(vault, directory, backupId, part));
  return Buffer.from(data, 'base64');
}
/*
 * A manifest's bytes change with each seal, and key rotation reseals it. So a backup keeps the
 * manifest opened (inside its own seal) and compares what manifests say, not how they are sealed.
 */
export function openManifest(vault: Vault, bytes: Uint8Array) {
  const { sealed, ...plain } = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    sealed: unknown;
  };
  return { plain, data: vault.open(sealed, plain) };
}
export function manifestFingerprint(vault: Vault, bytes: Uint8Array) {
  return hashJson(openManifest(vault, bytes));
}
export function sealManifestCopy(vault: Vault, value: unknown) {
  const { plain, data } = manifestCopySchema.parse(value);
  return Buffer.from(`${JSON.stringify({ ...plain, sealed: vault.seal(data, plain) }, null, 2)}\n`);
}
const manifestCopySchema = z.object({ plain: z.looseObject({}), data: z.unknown() });

export async function commonDirOf(dashboard: Dashboard, repoId: string) {
  const main = (await dashboard.sync.worktrees(repoId))[0]?.path;
  if (!main) throw new OperationError('validation', 'The source repository is not available');
  return (await resolveRepo(main)).commonDir;
}
/**
 * Backups hold source bytes, so they live beside the source inside its Git directory: never in the
 * cloak, where an agent could read them, and never committed.
 */
export function backupRoot(commonDir: string, workspaceId: string) {
  return { base: commonDir, relative: `repo-cloak-backups/${hashJson(workspaceId).slice(7, 39)}` };
}
