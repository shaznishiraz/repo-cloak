import { basename } from 'node:path';
import { z } from 'zod';
import { hashBytes } from '../../../core/hash.js';
import type { PreviewMatch } from '../../../core/ledger.js';
import type { Snapshot } from '../../../core/manifest.js';
import type { Dashboard } from '../../../application/dashboard.js';
import type {
  GuardCheck,
  PushFile,
  PushFileFlag,
  PushReview,
  PushTarget,
} from '../../../web/api/contracts.js';
import { canonicalPath } from '../../files.js';
import { repoState, runGit } from '../../git.js';
import { OperationError } from '../../ui-operations.js';
import type { PreparedOperation } from '../../ui-operations.js';
import { diffLines, linesOf, wordAround } from './diff.js';
import { baselineOf, inspect, readOne } from './inspect.js';
import type { Baseline, Inspection, RestoredFile } from './inspect.js';
import { planMerges } from './merge.js';
import { defaultOptions, pendingFor } from './state.js';
import type { Pending } from './state.js';

async function restoreInput(
  dashboard: Dashboard,
  repoId: string,
  workspaceId: string,
  snapshot: Snapshot,
  target: PushTarget,
) {
  const base = { intent: 'restore', repoId, workspaceId, policy: 'force' } as const;
  const trees = await dashboard.sync.worktrees(repoId);
  const main = trees[0]?.path;
  switch (target.kind) {
    case 'main':
      if (!main) throw new OperationError('validation', 'The main checkout is not available');
      return { ...base, worktree: main };
    case 'worktree':
      return { ...base, worktree: target.path };
    case 'new-worktree': {
      const commit = main ? (await repoState(main)).commit : null;
      return { ...base, newWorktree: target.branch, ...(commit ? { base: commit } : {}) };
    }
    default: {
      // The worktree this cloak was pulled from, while it still exists.
      const origin = await canonicalPath(snapshot.data.origin.worktree).catch(() => undefined);
      const found = await Promise.all(trees.map((tree) => canonicalPath(tree.path)));
      return origin && found.includes(origin) ? { ...base, worktree: origin } : base;
    }
  }
}
function derivedNames(inspection: Inspection, baselines: Map<string, Baseline | undefined>) {
  const { replacer, ledger, files, pathPreview } = inspection;
  const names = new Map<string, string>();
  const perFile = new Map<string, boolean>();
  const collect = (
    file: string,
    text: string,
    preview: PreviewMatch[],
    known: string | undefined,
    scope: 'content' | 'paths',
  ) => {
    for (const match of preview) {
      if (match.status !== 'replaced' || match.kind === 'secret') continue;
      const word = wordAround(text, match.start, match.end);
      if (word === match.anonymized && !match.isNew) continue;
      if (known?.includes(word)) continue;
      try {
        names.set(word, replacer.restore(word, ledger, { file, scope }).text);
        perFile.set(file, true);
      } catch {
        // The file already reports this name as a failed check.
      }
    }
  };
  for (const file of files) {
    if (file.file?.text !== undefined)
      collect(
        file.cloaked,
        file.file.text,
        file.preview,
        baselines.get(file.cloaked)?.cloaked,
        'content',
      );
    for (const { segment, preview } of pathPreview.get(file.cloaked) ?? [])
      collect(file.cloaked, segment, preview, undefined, 'paths');
  }
  return {
    derived: [...names].slice(0, 50).map(([cloaked, restored]) => ({ cloaked, restored })),
    perFile,
  };
}
async function targetCheck(root: string, pulled: string | null): Promise<GuardCheck> {
  const dirty = (await runGit(root, ['status', '--porcelain']).catch(() => ''))
    .split('\n')
    .filter(Boolean).length;
  const head = (await runGit(root, ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim();
  const ahead = pulled
    ? Number(
        (await runGit(root, ['rev-list', '--count', `${pulled}..HEAD`]).catch(() => '0')).trim(),
      )
    : 0;
  const upstream = `${ahead} new upstream commit${ahead === 1 ? '' : 's'}`;
  return {
    id: 'target',
    state: dirty ? 'warning' : 'info',
    title: dirty
      ? `target has ${dirty} uncommitted change${dirty === 1 ? '' : 's'}`
      : 'target is clean',
    detail: head ? `HEAD ${head}${ahead ? ` → ${upstream}` : ''}` : 'no commits yet',
  };
}
export async function review(
  dashboard: Dashboard,
  repoId: string,
  workspaceId: string,
  target: PushTarget,
): Promise<PushReview> {
  const inspection = await inspect(dashboard, repoId, workspaceId);
  const { snapshot, problems } = inspection;
  const baselines = new Map<string, Baseline | undefined>();
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const file of inspection.files) {
    const { baseline } = await baselineOf(inspection, file.cloaked);
    baselines.set(file.cloaked, baseline);
    const ops = diffLines(
      linesOf(baseline?.cloaked ?? ''),
      file.file?.binary ? [] : linesOf(file.file?.text ?? ''),
    );
    counts.set(file.cloaked, {
      additions: ops.filter((op) => op.kind === 'add').length,
      deletions: ops.filter((op) => op.kind === 'remove').length,
    });
  }
  const { derived, perFile } = derivedNames(inspection, baselines);
  const leaks = problems.filter((item) => item.leak);
  const unrestored = problems.filter((item) => !item.leak);
  const terms = [
    ...new Set(
      snapshot.data.rules.flatMap((rule) => (rule.type === 'literal' ? [rule.replace] : [])),
    ),
  ];
  const checks: GuardCheck[] = [
    {
      id: 'restores',
      state: unrestored.length ? 'blocked' : 'ok',
      title: unrestored.length
        ? `${unrestored.length} file${unrestored.length === 1 ? '' : 's'} cannot be restored`
        : 'Every cloaked name restores',
      detail:
        unrestored[0]?.message ??
        `${snapshot.data.rules.length} rule${snapshot.data.rules.length === 1 ? '' : 's'} · ${derived.length} derived · 0 left`,
    },
    {
      id: 'no-leak',
      state: leaks.length ? 'blocked' : 'ok',
      title: leaks.length
        ? 'A cloaked name would leak into the source'
        : 'No cloaked name leaks into source',
      detail:
        leaks[0]?.message ??
        `${terms.slice(0, 2).join(' / ') || 'all rules'}: 0 hits after restore`,
    },
  ];
  const finish = (
    files: PushFile[],
    operationId: string | null,
    canApply: boolean,
  ): PushReview => ({
    target,
    files,
    checks,
    derivedNames: derived,
    operationId,
    canApply,
  });
  const describe = (
    keep: (file: RestoredFile) => boolean,
    flags: (file: RestoredFile) => PushFileFlag[],
  ) =>
    inspection.files.filter(keep).map((file) => ({
      path: file.cloaked,
      restoredPath: file.restoredPath,
      status: file.status,
      additions: counts.get(file.cloaked)?.additions ?? 0,
      deletions: counts.get(file.cloaked)?.deletions ?? 0,
      flags: flags(file),
    }));
  const derivedFlag = (file: RestoredFile): PushFileFlag[] =>
    perFile.get(file.cloaked) ? ['new-derived-name'] : [];
  if (problems.length)
    return finish(
      describe(
        () => true,
        (file) => ['clean', ...derivedFlag(file)],
      ),
      null,
      false,
    );
  let prepared: PreparedOperation;
  try {
    prepared = await dashboard.sync.prepareOperation(
      await restoreInput(dashboard, repoId, workspaceId, snapshot, target),
    );
  } catch (error) {
    if (error instanceof OperationError || error instanceof z.ZodError) throw error;
    checks.push({
      id: 'target',
      state: 'blocked',
      title: 'This target cannot take the push',
      detail: error instanceof Error ? error.message : 'Preparing the push failed',
    });
    return finish(
      describe(
        () => true,
        (file) => ['clean', ...derivedFlag(file)],
      ),
      null,
      false,
    );
  }
  const { summary } = prepared;
  const destination = summary.destination.path;
  const isNewTree = target.kind === 'new-worktree';
  const conflicts = [...new Set(summary.conflicts)];
  const { merges, notes } = isNewTree
    ? { merges: new Map<string, Uint8Array | null>(), notes: [] as GuardCheck[] }
    : await planMerges(inspection, conflicts, destination);
  const landing = new Set([...summary.writes, ...summary.deletes]);
  const conflicted = new Set(conflicts);
  const held = await Promise.all(
    inspection.files
      .filter((file) => !landing.has(file.restoredPath) && !conflicted.has(file.cloaked))
      .map(async (file) => {
        const current = isNewTree ? undefined : await readOne(destination, file.restoredPath);
        const same =
          file.bytes && current?.bytes && hashBytes(file.bytes) === hashBytes(current.bytes);
        return same || (!file.bytes && !current?.bytes) ? undefined : file.cloaked;
      }),
  ).then((list) => new Set(list.filter((path) => path !== undefined)));
  const files = describe(
    (file) => landing.has(file.restoredPath) || conflicted.has(file.cloaked),
    (file) => {
      const derivedOnly = derivedFlag(file);
      if (!conflicted.has(file.cloaked)) return ['clean', ...derivedOnly];
      return merges.get(file.restoredPath)
        ? ['source-moved', 'auto-merge', ...derivedOnly]
        : ['source-moved', 'conflict', ...derivedOnly];
    },
  );
  const blocked = notes.filter((note) => note.state === 'blocked');
  const clean = notes.length - blocked.length;
  checks.push({
    id: 'merges',
    state: blocked.length ? 'blocked' : clean ? 'info' : 'ok',
    title: blocked.length
      ? `${blocked.length} file${blocked.length === 1 ? ' overlaps' : 's overlap'} upstream changes`
      : clean
        ? `${clean} file${clean === 1 ? '' : 's'} auto-merge${clean === 1 ? 's' : ''} with upstream`
        : 'No upstream changes to merge',
    detail: notes.length
      ? conflicts.map((path) => basename(path)).join(', ')
      : 'source matches what you pulled',
  });
  checks.push(...notes);
  const added = files.filter((file) => file.status === 'added').length;
  checks.push({
    id: 'manifest',
    state: held.size ? 'warning' : 'ok',
    title: 'Only files from this cloak',
    detail: held.size
      ? `${held.size} held back by exclusions: ${[...held].slice(0, 3).join(', ')}`
      : added
        ? `${added} new, eligible under your rules`
        : 'no paths outside the manifest',
  });
  const pulled = snapshot.data.pulls.at(-1)?.commit ?? snapshot.data.origin.commit;
  checks.push(
    isNewTree
      ? {
          id: 'target',
          state: 'info',
          title: 'A new worktree will be created',
          detail: `${destination} · ${summary.destination.branch ?? target.branch}`,
        }
      : await targetCheck(destination, pulled),
  );
  for (const warning of summary.warnings.filter(
    (text) => !text.endsWith('skipped source conflict'),
  ))
    checks.push({ id: `warning:${checks.length}`, state: 'warning', title: warning });
  const readOnly = target.kind === 'dry-run' || target.kind === 'patch';
  if (readOnly || !files.length) return finish(files, null, false);

  const pending: Pending = {
    repoId,
    workspaceId,
    merges,
    files: new Map(files.map((file) => [file.path, file.restoredPath])),
    deletes: summary.deletes,
    workspace: inspection.workspace,
    isNewTree,
    options: defaultOptions,
  };
  const all = pendingFor(dashboard);
  // One review per workspace holds plan memory; the newest replaces the last.
  for (const [id, item] of all) {
    const state = (() => {
      try {
        return dashboard.sync.status(id).state;
      } catch {
        return undefined;
      }
    })();
    if (state !== 'pending') all.delete(id);
    else if (item.repoId === repoId && item.workspaceId === workspaceId) {
      dashboard.sync.cancel(id);
      all.delete(id);
    }
  }
  const mergedBytes = [...merges.values()].reduce((sum, bytes) => sum + (bytes?.length ?? 0), 0);
  const preview = await dashboard.sync.operations.preview(() =>
    Promise.resolve({
      ...prepared,
      // Only the push route can apply this, with a selection and acknowledgements of its own.
      owner: 'push-review',
      bytes: prepared.bytes + mergedBytes,
      apply: () => Promise.reject(new OperationError('validation', 'Apply this from Push review')),
    }),
  );
  all.set(preview.operationId, pending);
  return finish(files, preview.operationId, summary.canApply);
}
