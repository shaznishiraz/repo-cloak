import { z } from 'zod';
import { validateRelativePath } from '../../core/paths.js';
import type { DiffLine, PushBackup } from '../../web/api/contracts.js';
import { OperationError } from '../ui-operations.js';
import { restoredMessage } from './push/apply.js';
import { backupIdSchema, commonDirOf, readBackups, undo } from './push/backups.js';
import { diffLines, linesOf, maskSecrets } from './push/diff.js';
import { baselineOf, inspect } from './push/inspect.js';
import { review } from './push/review.js';
import { pendingFor } from './push/state.js';
import { RequestError, route } from './router.js';
import type { Route } from './router.js';

/** Above this a text diff stops being useful and the side-by-side view shows a note instead. */
const diffFileLimit = 1024 * 1024;
const repoIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const workspaceIdSchema = z.string().min(1).max(200);
const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('origin') }).strict(),
  z.object({ kind: z.literal('main') }).strict(),
  z.object({ kind: z.literal('worktree'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal('new-worktree'), branch: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('patch') }).strict(),
  z.object({ kind: z.literal('dry-run') }).strict(),
]);
const reviewSchema = z.object({ target: targetSchema }).strict();
const applySchema = z
  .object({
    operationId: z.string().uuid(),
    mode: z.enum(['write', 'stage', 'commit']),
    commitMessage: z.string().trim().min(1).max(4000).optional(),
    repull: z.boolean(),
    includeGroupMembers: z.boolean(),
    mergeMode: z.enum(['merge', 'overwrite']),
  })
  .strict()
  .refine((value) => value.mode !== 'commit' || value.commitMessage !== undefined, {
    message: 'Enter a commit message',
    path: ['commitMessage'],
  });
const diffQuerySchema = z.object({ path: z.string().min(1).max(4096) }).strict();

function ids(params: Record<string, string>) {
  return {
    repoId: repoIdSchema.parse(params.repoId),
    workspaceId: workspaceIdSchema.parse(params.id),
  };
}

export const pushRoutes: Route[] = [
  route('POST /api/v2/push/:repoId/:id/review', async ({ dashboard, params, body }) => {
    const { repoId, workspaceId } = ids(params);
    const { target } = reviewSchema.parse(await body());
    return review(dashboard, repoId, workspaceId, target);
  }),
  route('GET /api/v2/push/:repoId/:id/diff', async ({ dashboard, params, query }) => {
    const { repoId, workspaceId } = ids(params);
    const { path } = diffQuerySchema.parse(Object.fromEntries(query));
    const inspection = await inspect(dashboard, repoId, workspaceId);
    const entry = inspection.files.find((file) => file.cloaked === validateRelativePath(path));
    if (!entry) throw new RequestError(404, 'This file has no pending change');
    if (entry.file?.binary || (entry.file?.bytes?.length ?? 0) > diffFileLimit)
      return { lines: [] };
    const { baseline, ledger } = await baselineOf(inspection, path);
    if ((baseline?.cloaked.length ?? 0) > diffFileLimit) return { lines: [] };
    const beforeCloaked = linesOf(baseline?.cloaked ?? '');
    const beforeRestored = linesOf(maskSecrets(baseline?.restored ?? '', ledger));
    const afterCloaked = linesOf(entry.file?.text ?? '');
    const afterRestored = linesOf(maskSecrets(entry.text ?? '', ledger));
    const ops = diffLines(beforeCloaked, afterCloaked);
    // Three lines of context around each change; a jump in `line` marks the next hunk.
    const nearChange = new Set<number>();
    ops.forEach((op, index) => {
      if (op.kind === 'context') return;
      for (let near = index - 3; near <= index + 3; near++) nearChange.add(near);
    });
    const lines: DiffLine[] = [];
    ops.forEach((op, index) => {
      if (!nearChange.has(index)) return;
      lines.push(
        op.kind === 'remove'
          ? {
              kind: op.kind,
              line: op.before + 1,
              cloaked: beforeCloaked[op.before] ?? '',
              restored: beforeRestored[op.before] ?? '',
            }
          : {
              kind: op.kind,
              line: op.after + 1,
              cloaked: afterCloaked[op.after] ?? '',
              restored: afterRestored[op.after] ?? '',
            },
      );
    });
    return { lines };
  }),
  route('POST /api/v2/push/:repoId/:id/apply', async ({ dashboard, params, body }) => {
    const { repoId, workspaceId } = ids(params);
    const input = applySchema.parse(await body());
    const pending = pendingFor(dashboard).get(input.operationId);
    if (!pending || pending.repoId !== repoId || pending.workspaceId !== workspaceId)
      throw new OperationError('unknown', 'This review has ended; review the push again');
    if (input.mergeMode === 'merge' && [...pending.merges.values()].includes(null))
      throw new OperationError(
        'conflict',
        'Some files overlap upstream changes. Pull first, or choose to overwrite them.',
      );
    const message =
      input.mode === 'commit' && input.commitMessage
        ? restoredMessage(await inspect(dashboard, repoId, workspaceId), input.commitMessage)
        : undefined;
    const { mode, repull, includeGroupMembers, mergeMode } = input;
    pending.options = { mode, repull, includeGroupMembers, mergeMode, message };
    // The review listed the deletions and overwrites, and the screen confirmed them.
    return dashboard.sync.operations.apply(input.operationId, { deletions: true, force: true });
  }),
  route('GET /api/v2/push/:repoId/:id/backups', async ({ dashboard, params }) => {
    const { repoId, workspaceId } = ids(params);
    await dashboard.sync.workspaceTarget(repoId, workspaceId);
    const backups = await readBackups(
      await dashboard.sync.vault(),
      await commonDirOf(dashboard, repoId),
      workspaceId,
    );
    return {
      backups: backups.map(({ id, createdAt, expiresAt, files }): PushBackup => ({
        id,
        createdAt,
        expiresAt,
        files: files.length,
      })),
    };
  }),
  route('POST /api/v2/push/:repoId/:id/backups/:backupId/undo', async ({ dashboard, params }) => {
    const { repoId, workspaceId } = ids(params);
    return undo(dashboard, repoId, workspaceId, backupIdSchema.parse(params.backupId));
  }),
];
