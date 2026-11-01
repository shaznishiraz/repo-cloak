import { basename, join } from 'node:path';
import { createReplacer } from '../../../core/replacer.js';
import { hashBytes } from '../../../core/hash.js';
import type { Dashboard } from '../../../application/dashboard.js';
import { exists } from '../../files.js';
import { runGit } from '../../git.js';
import { OperationError } from '../../ui-operations.js';
import type { PreparedOperation, SyncResult } from '../../ui-operations.js';
import { commonDirOf } from './backup-parts.js';
import { readBackups } from './backups.js';
import { createBackupSession, journalIds } from './journal.js';
import type { BackupSession } from './journal.js';
import type { Inspection } from './inspect.js';
import { noticesFor, pushedTo } from './state.js';
import type { Options, Pending } from './state.js';

function describeError(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  const stderr =
    error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
  return (
    stderr.split('\n')[0] ||
    (error instanceof Error ? error.message : cause ? String(cause) : 'failed')
  );
}
async function stageAndCommit(root: string, paths: string[], options: Options) {
  const warnings: string[] = [];
  if (!paths.length || options.mode === 'write') return { warnings, commit: undefined };
  const literal = ['--literal-pathspecs'];
  const ignored = new Set(
    (
      await runGit(root, [...literal, 'check-ignore', '--no-index', '-z', '--', ...paths]).catch(
        () => '',
      )
    )
      .split('\0')
      .filter(Boolean),
  );
  const tracked = new Set(
    (await runGit(root, [...literal, 'ls-files', '-z', '--', ...paths]))
      .split('\0')
      .filter(Boolean),
  );
  const eligible = [];
  for (const path of paths)
    if (tracked.has(path) || (!ignored.has(path) && (await exists(join(root, path)))))
      eligible.push(path);
  if (ignored.size)
    warnings.push(
      `${ignored.size} ignored file${ignored.size === 1 ? ' was' : 's were'} not staged`,
    );
  if (!eligible.length) return { warnings, commit: undefined };
  await runGit(root, [...literal, 'add', '-A', '--', ...eligible]);
  if (options.mode !== 'commit' || !options.message) return { warnings, commit: undefined };
  await runGit(root, [...literal, 'commit', '--only', '-m', options.message, '--', ...eligible]);
  return { warnings, commit: (await runGit(root, ['rev-parse', '--short', 'HEAD'])).trim() };
}
/** The reviewed operation, narrowed to this selection with its merges in the same write. */
export function chooseReviewed(
  dashboard: Dashboard,
  pending: Pending,
  reviewed: PreparedOperation,
  paths: string[] | undefined,
): PreparedOperation {
  if (!reviewed.select) throw new Error('This operation cannot be narrowed');
  const { merges, options, repoId, workspaceId, workspace, isNewTree } = pending;
  const landing = new Set(paths?.map((path) => pending.files.get(path)));
  const selected = (path: string) => !paths || landing.has(path);
  const merged = new Map<string, Uint8Array>();
  if (options.mergeMode === 'merge')
    for (const [path, bytes] of merges) if (bytes && selected(path)) merged.set(path, bytes);
  const session = createBackupSession(dashboard, {
    repoId,
    workspaceId,
    workspace,
    root: reviewed.summary.destination.path,
    newTree: isNewTree,
    mode: options.mode,
  });
  const chosen = reviewed.select({ paths, merged, beforeWrite: session.begin });
  const forced = options.mergeMode === 'overwrite' && [...merges.keys()].some(selected);
  return {
    ...chosen,
    summary: { ...chosen.summary, forced },
    apply: () => runPush(dashboard, workspace, pending, chosen, session, merged),
  };
}
async function runPush(
  dashboard: Dashboard,
  workspace: string,
  pending: Pick<Pending, 'repoId' | 'workspaceId' | 'options'>,
  prepared: PreparedOperation,
  session: BackupSession,
  merged: ReadonlyMap<string, Uint8Array>,
): Promise<SyncResult> {
  const { repoId, workspaceId, options } = pending;
  const { summary } = prepared;
  const root = summary.destination.path;
  const commonDir = await commonDirOf(dashboard, repoId);
  const touched = [...new Set([...summary.writes, ...summary.deletes])];
  await readBackups(await dashboard.sync.vault(), commonDir, workspaceId);
  if ((await journalIds(commonDir, workspaceId)).length)
    throw new OperationError(
      'conflict',
      'An earlier push was interrupted and has not been recovered yet. Review this push again.',
    );
  let result: SyncResult;
  try {
    result = await prepared.apply();
  } catch (error) {
    // A journal it cannot settle stays on disk, so the next run decides.
    await session.settle().catch(() => {});
    throw error;
  }
  const warnings = [...result.warnings];
  const auditTarget = { repoId, id: workspaceId, name: basename(workspace) };
  if (merged.size)
    await dashboard.sync.audit.record({
      op: 'push',
      outcome: 'ok',
      workspace: auditTarget,
      files: [...merged].map(([path, bytes]) => ({ path, hash: hashBytes(bytes) })),
      detail: '3-way merge with upstream',
    });
  try {
    const { warnings: notes, commit } = await stageAndCommit(root, touched, options);
    warnings.push(...notes);
    if (commit) {
      warnings.push(`Committed ${commit}`);
      await dashboard.sync.audit.record({
        op: 'push',
        outcome: 'ok',
        workspace: auditTarget,
        detail: `Committed ${commit}`,
      });
    }
  } catch (error) {
    warnings.push(
      `Files were written, but ${options.mode === 'commit' ? 'committing' : 'staging'} failed: ${describeError(error)}`,
    );
  }
  if (options.repull) {
    try {
      const refresh = await dashboard.sync.prepareOperation({
        intent: 'refresh',
        repoId,
        workspaceId,
        worktree: root,
      });
      if (refresh.summary.deletes.length || refresh.summary.profileChanges.length)
        warnings.push('Re-pull needs review because profiles or deletions changed; pull manually');
      else await refresh.apply();
    } catch (error) {
      warnings.push(`Files were written, but the re-pull failed: ${describeError(error)}`);
    }
  }
  try {
    await session.finish();
  } catch (error) {
    // The journal is still there, so the next review finishes this and offers undo.
    warnings.push(`Undo is not available yet: ${describeError(error)}`);
  }
  noticesFor(dashboard).delete(workspaceId);
  pushedTo(dashboard).set(workspaceId, root);
  if (options.includeGroupMembers)
    warnings.push(...(await pushMembers(dashboard, repoId, workspaceId, options)));
  return { ...result, warnings };
}
/**
 * Members were not reviewed on this screen, so only an unconflicted, delete-free push goes ahead.
 * Anything else is left for its own review, and one member failing does not undo another.
 */
async function pushMembers(
  dashboard: Dashboard,
  repoId: string,
  workspaceId: string,
  options: Options,
) {
  const notes: string[] = [];
  const group = (await dashboard.groups.list()).find((item) =>
    item.members.some((member) => member.repoId === repoId && member.workspaceId === workspaceId),
  );
  for (const member of group?.members ?? []) {
    if (member.workspaceId === workspaceId && member.repoId === repoId) continue;
    let name = member.workspaceId;
    try {
      const target = await dashboard.sync.workspaceTarget(member.repoId, member.workspaceId);
      name = basename(target.path);
      const prepared = await dashboard.sync.prepareOperation({
        intent: 'restore',
        repoId: member.repoId,
        workspaceId: member.workspaceId,
        worktree: member.worktree,
        policy: 'block',
      });
      const { summary } = prepared;
      if (!summary.canApply || summary.conflicts.length) {
        notes.push(`${name}: not pushed, the source moved; review it on its own`);
        continue;
      }
      if (summary.deletes.length) {
        notes.push(`${name}: not pushed, it deletes files; review it on its own`);
        continue;
      }
      if (!summary.writes.length) continue;
      const message =
        options.message === undefined
          ? undefined
          : createReplacer(target.snapshot.data.rules).restore(
              options.message,
              target.snapshot.data.ledger,
              { file: 'commit message', scope: 'content' },
            ).text;
      if (!prepared.select) throw new Error('This operation cannot be narrowed');
      const session = createBackupSession(dashboard, {
        repoId: member.repoId,
        workspaceId: member.workspaceId,
        workspace: target.path,
        root: summary.destination.path,
        newTree: false,
        mode: options.mode,
      });
      await runPush(
        dashboard,
        target.path,
        {
          repoId: member.repoId,
          workspaceId: member.workspaceId,
          options: { ...options, message, includeGroupMembers: false },
        },
        prepared.select({ beforeWrite: session.begin }),
        session,
        new Map(),
      );
      notes.push(`${name}: ${summary.writes.length} files pushed`);
    } catch (error) {
      notes.push(`${name}: not pushed: ${describeError(error)}`);
    }
  }
  return notes;
}

export function restoredMessage(inspection: Inspection, message: string) {
  let result: ReturnType<Inspection['replacer']['restore']>;
  try {
    result = inspection.replacer.restore(message, inspection.ledger, {
      file: 'commit message',
      scope: 'content',
    });
  } catch (cause) {
    throw new OperationError(
      'validation',
      cause instanceof Error
        ? `The commit message cannot be restored: ${cause.message}`
        : 'The commit message cannot be restored',
    );
  }
  if (result.preview.some((match) => match.kind === 'secret'))
    throw new OperationError('validation', 'The commit message must not contain a secret');
  return result.text;
}
