import { basename, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import type { Dashboard } from '../../application/dashboard.js';
import { runStatus } from '../../application/status.js';
import { groupInputSchema, groupMemberSchema } from '../../core/groups.js';
import type { RepositoryGroup } from '../../core/groups.js';
import { restorePaths } from '../../core/paths.js';
import { planPush } from '../../core/push.js';
import type { SourceFile } from '../../core/pull.js';
import { createReplacer } from '../../core/replacer.js';
import type {
  AgentRequest,
  AuditEventView,
  GuardCheck,
  Overview,
  OverviewWorkspace,
  PendingChange,
  PushTarget,
  PullTarget,
} from '../../web/api/contracts.js';
import type {
  GroupDetailView,
  GroupOperationView,
  TargetPreview,
  WorkspaceDetailView,
} from '../../web/api/contracts.js';
import type { LeakScan } from '../../core/leak-scan.js';
import { createCommitDiff } from '../commit-diff.js';
import { readSourceFiles } from '../files.js';
import { repoState, runGit } from '../git.js';
import { scanWithRepoIdentity } from './leak-guard.js';
import { createStatusIO } from '../status.js';
import { OperationError } from '../ui-operations.js';
import type { PreviewSummary } from '../ui-operations.js';
import { RequestError, route } from './router.js';
import type { Route, RouteContext } from './router.js';

/* ---------- Input checks: every param, query and body passes through one of these ---------- */
const repoIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const workspaceIdSchema = z.string().min(1).max(200);
const uuidSchema = z.uuid();
const pathSchema = z.string().min(1).max(4096);
// `-x` could read as a Git option even where `--end-of-options` is not in play.
const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^-\s]\S*$/, 'Use a branch, tag or commit name');
const branchSchema = refSchema.regex(/^[^~^:?*[\\]+$/, 'Use a valid branch name');
const pushTargetSchema = z
  .object({
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('origin') }),
      z.strictObject({ kind: z.literal('main') }),
      z.strictObject({ kind: z.literal('worktree'), path: pathSchema }),
      z.strictObject({ kind: z.literal('new-worktree'), branch: branchSchema }),
      z.strictObject({ kind: z.literal('patch') }),
      z.strictObject({ kind: z.literal('dry-run') }),
    ]),
  })
  .strict();
const pullTargetSchema = z
  .object({
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('origin') }),
      z.strictObject({ kind: z.literal('main') }),
      z.strictObject({ kind: z.literal('worktree'), path: pathSchema }),
      z.strictObject({ kind: z.literal('commit'), ref: refSchema }),
    ]),
  })
  .strict();
const bulkSchema = z
  .object({
    direction: z.enum(['pull', 'push']),
    revision: z.string().min(1).max(200),
    stopOnGuardFailure: z.boolean(),
    commitMessage: z.string().trim().min(1).max(2000).optional(),
    members: z.array(repoIdSchema).min(1).max(8).optional(),
  })
  .strict();
const desktopSchema = z.object({ target: z.enum(['folder', 'vscode', 'zed', 'orca']) }).strict();
const groupSaveSchema = groupInputSchema.extend({
  moveWorkspaces: z.boolean().optional(),
  folderRoot: z.string().trim().min(1).max(4096).optional(),
});
const revisionSchema = z.object({ revision: z.string().min(1).max(200) }).strict();
const groupAckSchema = z
  .object({
    members: z
      .array(
        z
          .object({
            repoId: repoIdSchema,
            deletions: z.boolean().optional(),
            profiles: z.boolean().optional(),
            force: z.boolean().optional(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
const commitsQuerySchema = z
  .object({
    offset: z
      .string()
      .regex(/^\d{1,6}$/)
      .optional(),
    ref: refSchema.optional(),
  })
  .strict();
const shaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

function check<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new RequestError(
    400,
    `Invalid request: ${[...(issue?.path ?? []), issue?.message].join(': ')}`,
  );
}
function workspaceParams({ params }: RouteContext) {
  return {
    repoId: check(repoIdSchema, params.repoId),
    id: check(workspaceIdSchema, params.id),
  };
}
const message = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

/* ---------- Shaping engine results into the contract ---------- */
function toSummary(value: PreviewSummary): PreviewSummary {
  const {
    intent,
    source,
    destination,
    writes,
    deletes,
    warnings,
    conflicts,
    profileChanges,
    replacements,
    canApply,
    forced,
    redactions,
    postCreateCommands,
    sourceCommit,
  } = value;
  return {
    intent,
    source,
    destination,
    writes,
    deletes,
    warnings,
    conflicts,
    profileChanges,
    replacements,
    canApply,
    forced,
    redactions,
    postCreateCommands,
    ...(sourceCommit ? { sourceCommit } : {}),
  };
}
function toPreview(flat: PreviewSummary & { operationId: string; expiresAt: string }) {
  return { operationId: flat.operationId, expiresAt: flat.expiresAt, summary: toSummary(flat) };
}

/* ---------- Workspace detail ---------- */
type Target = Awaited<ReturnType<Dashboard['sync']['workspaceTarget']>>;

/** Line counts between two texts. Moved lines count as unchanged, which is enough for a badge. */
export function countLines(before: string, after: string) {
  const lines = (text: string) => (text ? text.replace(/\n$/, '').split('\n') : []);
  const remaining = new Map<string, number>();
  for (const line of lines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of lines(after)) {
    const left = remaining.get(line) ?? 0;
    if (left) remaining.set(line, left - 1);
    else additions++;
  }
  let deletions = 0;
  for (const left of remaining.values()) deletions += left;
  return { additions, deletions };
}

/** The worktree to act on. Omitting an origin that has gone lets the engine find its branch. */
async function chooseWorktree(
  dashboard: Dashboard,
  repoId: string,
  snapshot: Target['snapshot'],
  target: PushTarget | PullTarget,
): Promise<string | undefined> {
  if (target.kind === 'worktree') return target.path;
  const trees = await dashboard.sync.worktrees(repoId);
  if (target.kind === 'main') {
    const main = trees[0]?.path;
    if (!main) throw new OperationError('validation', 'The main checkout is unavailable');
    return main;
  }
  const origin = snapshot.data.origin.worktree;
  return trees.some((tree) => tree.path === origin) ? origin : undefined;
}

async function movedFiles(snapshot: Target['snapshot']) {
  const { origin, pulls, files } = snapshot.data;
  const pulled = pulls.at(-1)?.commit ?? origin.commit;
  try {
    const head = (await repoState(origin.worktree)).commit;
    if (!pulled || !head || pulled === head) return 0;
    const changed = await runGit(origin.worktree, [
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      pulled,
      head,
      '--',
    ]);
    const tracked = new Set(Object.values(files).map((file) => file.path));
    return changed.split('\0').filter((path) => tracked.has(path)).length;
  } catch {
    return 0; // A rebased-away commit or moved worktree: the overview still reports it moved.
  }
}

/** Everything a restore would do, with the same exclusions, and without writing anything. */
async function inspectRestore(dashboard: Dashboard, repoId: string, id: string) {
  const target = await dashboard.sync.workspaceTarget(repoId, id);
  const { snapshot, path } = target;
  const status = await runStatus(createStatusIO(path));
  const worktree = await chooseWorktree(dashboard, repoId, snapshot, { kind: 'origin' });
  const { summary } = await dashboard.sync.prepareOperation({
    intent: 'restore',
    repoId,
    workspaceId: id,
    ...(worktree ? { worktree } : {}),
  });
  const replacer = createReplacer(snapshot.data.rules);
  const added = restorePaths(status.added, replacer, snapshot.data.ledger).paths;
  const mapping = new Map([
    ...Object.entries(snapshot.data.files).map(([cloaked, file]) => [cloaked, file.path] as const),
    ...added.map((entry) => [entry.anonymized, entry.original] as const),
  ]);
  const workspaceFiles = (await readSourceFiles(path, [...mapping.keys()], 16)).files;
  const sourceFiles = (
    await readSourceFiles(summary.destination.path, [...new Set(mapping.values())], 16)
  ).files;
  // `force` plans conflicting files as well so their line counts can still be shown. What may be
  // written is decided by `summary`, which came from the real exclusion and conflict rules.
  const plan = planPush(snapshot, workspaceFiles, sourceFiles, { force: true });
  return { target, status, summary, mapping, workspaceFiles, sourceFiles, plan };
}
type Inspection = Awaited<ReturnType<typeof inspectRestore>>;

function pendingChanges({ status, mapping, plan, sourceFiles }: Inspection): PendingChange[] {
  const writes = new Map(plan.writes.map((file) => [file.path, file.bytes]));
  const sources = new Map(sourceFiles.map((file) => [file.path, file]));
  const text = (bytes: Uint8Array | undefined) =>
    bytes ? Buffer.from(bytes).toString('utf8') : '';
  const change = (path: string, kind: PendingChange['status']): PendingChange => {
    const restoredPath = mapping.get(path) ?? path;
    const source = sources.get(restoredPath);
    const written = writes.get(restoredPath);
    const binary = source?.binary || (written && Buffer.from(written).includes(0));
    const counts = binary
      ? { additions: 0, deletions: 0 }
      : kind === 'deleted'
        ? countLines(text(source?.bytes), '')
        : written
          ? countLines(text(source?.bytes), text(written))
          : { additions: 0, deletions: 0 };
    return { path, restoredPath, status: kind, ...counts };
  };
  return [
    ...status.modified.map((path) => change(path, 'modified')),
    ...status.added.map((path) => change(path, 'added')),
    ...status.deleted.map((path) => change(path, 'deleted')),
  ];
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

async function scanWorkspace({ workspaceFiles, target }: Inspection) {
  const { source, rules, ledger } = target.snapshot.data;
  const documents = workspaceFiles
    .filter((file) => file.bytes)
    .map((file) => ({
      path: file.path,
      texts: file.text === undefined ? [file.path] : [file.path, file.text],
    }));
  return scanWithRepoIdentity(source.path, documents, rules, ledger);
}

/** Only ever a warning, and it never calls a quiet result safe. */
function heuristicGuard(scan: LeakScan): GuardCheck {
  const covered = scan.partial
    ? `partial scan, stopped at a limit after ${scan.filesScanned} of ${plural(scan.filesTotal, 'file')}`
    : `scanned ${plural(scan.filesScanned, 'file')}`;
  return scan.findings.length
    ? {
        id: 'leak-heuristics',
        state: 'warning',
        title: `${plural(scan.findings.length, 'possible leftover name')} (heuristic)`,
        detail: `${covered} · likely names, check each one`,
        findings: scan.findings,
      }
    : {
        id: 'leak-heuristics',
        state: 'info',
        title: 'Heuristic scan spotted no likely leftovers',
        detail: `${covered} · not proof the cloak is safe`,
      };
}

function guardChecks(inspection: Inspection, moved: number, scan: LeakScan): GuardCheck[] {
  const { summary, status, mapping, workspaceFiles, target, plan } = inspection;
  const { snapshot } = target;
  const conflicts = summary.conflicts;
  const planned = new Set([...summary.writes, ...summary.deletes]);
  const conflicted = new Set(conflicts);
  const held = [...status.modified, ...status.added, ...status.deleted].filter((path) => {
    const restored = mapping.get(path) ?? path;
    const wouldChange =
      plan.writes.some((file) => file.path === restored) || plan.deletes.includes(restored);
    return wouldChange && !planned.has(restored) && !conflicted.has(path);
  });
  const derived = status.added
    .map((path) => ({ path, restored: mapping.get(path) ?? path }))
    .filter((entry) => entry.path !== entry.restored);
  // Cloaked text always holds anonymized values, so look for the originals themselves, after
  // removing any anonymized value that happens to contain one. Only paths are ever reported.
  const pairs = snapshot.data.ledger.filter((entry) => entry.scope === 'content' && entry.original);
  const leaks = workspaceFiles.filter((file) => {
    if (!file.bytes || file.binary) return false;
    let text = Buffer.from(file.bytes).toString('utf8');
    for (const { anonymized } of pairs) text = text.replaceAll(anonymized, '');
    return pairs.some(({ original }) => text.includes(original));
  });
  const scanned = workspaceFiles.filter((file) => file.bytes && !file.binary).length;
  const profiles = snapshot.data.profiles.map((profile) => profile.name).join(' + ');
  return [
    {
      id: 'reversal',
      state: conflicts.length ? 'warning' : 'ok',
      title: `${plural(snapshot.data.ledger.length, 'replaced term')} reverse cleanly`,
      detail: `profile ${profiles || 'none'} · ${plural(snapshot.data.rules.length, 'rule')}`,
    },
    conflicts.length
      ? {
          id: 'source-moved',
          state: 'blocked',
          title: `${plural(conflicts.length, 'file')} changed on both sides`,
          detail: `${conflicts.slice(0, 3).join(', ')} · review the push to overwrite or pull first`,
        }
      : moved
        ? {
            id: 'source-moved',
            state: 'info',
            title: `${plural(moved, 'source file')} changed since pull`,
            detail: 'no overlap with your edits',
          }
        : {
            id: 'source-moved',
            state: 'ok',
            title: 'Source unchanged since pull',
            detail: 'safe to push straight through',
          },
    derived.length
      ? {
          id: 'derived-names',
          state: 'warning',
          title: `AI added ${plural(derived.length, 'new cloaked name')}`,
          detail: derived
            .slice(0, 2)
            .map((entry) => `${basename(entry.path)} → ${basename(entry.restored)}`)
            .join(' · '),
        }
      : { id: 'derived-names', state: 'ok', title: 'No new cloaked names' },
    held.length
      ? {
          id: 'exclusions',
          state: 'warning',
          title: `${plural(held.length, 'change')} held back by exclusions`,
          detail: held.slice(0, 3).join(', '),
        }
      : { id: 'exclusions', state: 'ok', title: 'No excluded or sensitive files touched' },
    leaks.length
      ? {
          id: 'leaks',
          state: 'blocked',
          title: `Real names found in ${plural(leaks.length, 'cloak file')}`,
          detail: leaks
            .slice(0, 3)
            .map((file) => file.path)
            .join(', '),
        }
      : {
          id: 'leaks',
          state: 'ok',
          title: 'No real names from the ledger found in the cloak',
          detail: `scanned ${plural(scanned, 'file')} · only checks known values`,
        },
    heuristicGuard(scan),
  ];
}

const requestStates = {
  pending: 'waiting',
  failed: 'failed',
  rejected: 'denied',
  pulled: 'pulled',
} as const;

/** One row per file, sharing the request's id: a decision applies to the whole request. */
async function waitingRequests(dashboard: Dashboard, workspace: OverviewWorkspace) {
  const { repoId, id, name } = workspace;
  const info = await dashboard.agents.info(repoId, id).catch(() => undefined);
  return (info?.requests ?? []).flatMap((request) =>
    request.files
      .filter((file) => file.state === 'pending' || file.state === 'failed')
      .map((file): AgentRequest => ({
        id: request.id,
        repoId,
        workspaceId: id,
        workspaceName: name,
        path: file.path,
        reason: request.reason,
        state: file.excluded ? 'blocked' : requestStates[file.state],
        createdAt: request.createdAt,
      })),
  );
}

async function auditEvents(dashboard: Dashboard): Promise<AuditEventView[]> {
  return (await dashboard.sync.audit.list({ limit: Number.MAX_SAFE_INTEGER })).events;
}

async function workspaceDetail(
  dashboard: Dashboard,
  repoId: string,
  id: string,
): Promise<WorkspaceDetailView> {
  const overview = await dashboard.shell.overview({});
  const workspace = overview.workspaces.find((item) => item.id === id && item.repoId === repoId);
  if (!workspace) throw new RequestError(404, 'Workspace is not registered');
  const events = (await auditEvents(dashboard)).filter((event) => event.workspace?.id === id);
  const worktrees = await dashboard.sync.worktrees(repoId).catch(() => []);
  const mainPath = worktrees[0]?.path;
  const main = mainPath ? await repoState(mainPath).catch(() => undefined) : undefined;
  const base: WorkspaceDetailView = {
    workspace,
    lastPushAt: events.find((event) => event.op === 'push' && event.outcome === 'ok')?.at ?? null,
    pending: [],
    guards: [],
    requests: await waitingRequests(dashboard, workspace),
    history: events.slice(0, 4),
    profiles: [],
    sourceMovedFiles: 0,
    worktrees,
    main: main ? { branch: main.branch, sha: main.commit } : null,
  };
  if (workspace.state === 'missing')
    return {
      ...base,
      guards: [
        {
          id: 'folder',
          state: 'blocked',
          title: 'Workspace folder is missing',
          detail: workspace.path,
        },
      ],
    };
  if (workspace.state === 'unreadable')
    return {
      ...base,
      guards: [{ id: 'folder', state: 'blocked', title: 'Workspace manifest cannot be read' }],
    };
  try {
    const inspection = await inspectRestore(dashboard, repoId, id);
    const { snapshot } = inspection.target;
    const moved = await movedFiles(snapshot);
    return {
      ...base,
      pending: pendingChanges(inspection),
      guards: guardChecks(inspection, moved, await scanWorkspace(inspection)),
      profiles: snapshot.data.profiles.map((profile) => profile.name),
      sourceMovedFiles: moved,
    };
  } catch (error) {
    return { ...base, guards: [{ id: 'restore', state: 'blocked', title: message(error) }] };
  }
}

/* ---------- Pull and push previews ---------- */
async function restoredPatch({ summary, plan, sourceFiles }: Inspection) {
  const paths = [...summary.writes, ...summary.deletes];
  if (!paths.length) return '';
  const allowed = new Set(paths);
  const after: SourceFile[] = plan.writes
    .filter((file) => allowed.has(file.path))
    .map((file) => ({
      path: file.path,
      bytes: file.bytes,
      executable: file.executable,
      binary: Buffer.from(file.bytes).includes(0),
    }));
  const before = sourceFiles.filter((file) => allowed.has(file.path) && file.bytes);
  const { patch } = await createCommitDiff({
    root: summary.destination.path,
    before,
    after,
    paths,
    rules: [],
    ledger: [],
  });
  return patch;
}

/** Shows what a restore would do. Nothing can be applied: the operation is already cancelled. */
async function previewWithoutApplying(dashboard: Dashboard, repoId: string, id: string) {
  const inspection = await inspectRestore(dashboard, repoId, id);
  const patch = await restoredPatch(inspection);
  const summary = { ...inspection.summary, canApply: false };
  const flat = await dashboard.sync.operations.preview(() =>
    Promise.resolve({
      summary,
      bytes: Buffer.byteLength(patch),
      apply: () => Promise.reject(new OperationError('validation', 'A dry run writes nothing')),
    }),
  );
  dashboard.sync.operations.cancel(flat.operationId);
  const preview: TargetPreview = { ...toPreview(flat), patch };
  return preview;
}

async function pushPreview(dashboard: Dashboard, repoId: string, id: string, target: PushTarget) {
  if (target.kind === 'patch' || target.kind === 'dry-run')
    return previewWithoutApplying(dashboard, repoId, id);
  const base = { intent: 'restore', repoId, workspaceId: id };
  if (target.kind === 'new-worktree')
    return toPreview(await dashboard.sync.preview({ ...base, newWorktree: target.branch }));
  const { snapshot } = await dashboard.sync.workspaceTarget(repoId, id);
  const worktree = await chooseWorktree(dashboard, repoId, snapshot, target);
  return toPreview(await dashboard.sync.preview({ ...base, ...(worktree ? { worktree } : {}) }));
}

async function pullPreview(dashboard: Dashboard, repoId: string, id: string, target: PullTarget) {
  const { snapshot } = await dashboard.sync.workspaceTarget(repoId, id);
  const worktree = await chooseWorktree(
    dashboard,
    repoId,
    snapshot,
    target.kind === 'commit' ? { kind: 'origin' } : target,
  );
  return toPreview(
    await dashboard.sync.preview({
      intent: 'refresh',
      repoId,
      workspaceId: id,
      ...(worktree ? { worktree } : {}),
      ...(target.kind === 'commit' ? { fromCommit: target.ref } : {}),
    }),
  );
}

/* ---------- Groups ---------- */
type SavedGroup = RepositoryGroup & { revision: string };

function memberPlan(toPush: number, moved: number, workspace: OverviewWorkspace | undefined) {
  if (!workspace || workspace.state === 'missing') return 'folder missing';
  if (workspace.state === 'unreadable') return 'manifest unreadable';
  if (toPush && moved) return `check ${plural(moved, 'moved file')}, then write ${toPush}`;
  if (toPush) return `write ${plural(toPush, 'file')}`;
  if (moved) return `pull ${plural(moved, 'file')}`;
  return workspace.sourceMoved ? 'pull to catch up' : 'nothing to do';
}

async function describeGroup(
  dashboard: Dashboard,
  group: SavedGroup,
  overview: Overview,
  events: AuditEventView[],
): Promise<GroupDetailView> {
  const members = await Promise.all(
    group.members.map(async (member) => {
      const workspace = overview.workspaces.find(
        (item) => item.id === member.workspaceId && item.repoId === member.repoId,
      );
      const repo = overview.repos.find((item) => item.id === member.repoId);
      const worktrees = await dashboard.sync.worktrees(member.repoId).catch(() => []);
      const snapshot = await dashboard.sync
        .workspaceTarget(member.repoId, member.workspaceId)
        .then((target) => target.snapshot)
        .catch(() => undefined);
      const moved = snapshot ? await movedFiles(snapshot) : 0;
      const counts = workspace?.counts;
      const toPush = counts ? counts.modified + counts.added + counts.deleted : 0;
      const inner = repo ? relative(repo.path, member.worktree) : '..';
      const target: PushTarget =
        member.worktree === snapshot?.data.origin.worktree
          ? { kind: 'origin' }
          : member.worktree === worktrees[0]?.path
            ? { kind: 'main' }
            : { kind: 'worktree', path: member.worktree };
      return {
        workspaceId: member.workspaceId,
        repoId: member.repoId,
        folder: `${workspace ? basename(workspace.path) : member.workspaceId}/`,
        source:
          repo && !inner.startsWith('..') && !isAbsolute(inner)
            ? join(repo.name, inner)
            : member.worktree,
        target,
        toPush,
        sourceMoved: moved,
        plan: memberPlan(toPush, moved, workspace),
        worktree: member.worktree,
        tracked: counts?.tracked ?? 0,
        worktrees,
      };
    }),
  );
  const ids = new Set(group.members.map((member) => member.workspaceId));
  return {
    id: group.id,
    name: group.name,
    folder: group.folder ?? null,
    revision: group.revision,
    members,
    // Not stored by the engine. The browser keeps the owner's choice for each group.
    rules: { stopOnGuardFailure: true, sameCommitMessage: true },
    runs: events
      .filter(
        (event) =>
          event.workspace &&
          ids.has(event.workspace.id) &&
          ['create', 'pull', 'push'].includes(event.op),
      )
      .slice(0, 6),
  };
}

async function requireGroup(dashboard: Dashboard, id: string): Promise<SavedGroup> {
  const group = (await dashboard.groups.list()).find((item) => item.id === id);
  if (!group) throw new RequestError(404, 'Group no longer exists');
  return group;
}
async function groupView(dashboard: Dashboard, id: string) {
  return describeGroup(
    dashboard,
    await requireGroup(dashboard, id),
    await dashboard.shell.overview({}),
    await auditEvents(dashboard),
  );
}

/* ---------- Bulk runs: the engine owns the sequence, this only validates and shapes ---------- */
function memberStates(members: GroupOperationView['members']) {
  return members.map(({ repoId, state, error }) => ({
    repoId,
    state,
    ...(error ? { error } : {}),
  }));
}
function batchStatusView(dashboard: Dashboard, id: string): GroupOperationView {
  const state = dashboard.groups.status(id);
  return {
    operationId: id,
    state: state.state,
    expiresAt: state.expiresAt,
    members: memberStates(state.members),
    ...(state.error ? { error: state.error } : {}),
  };
}
async function bulk(dashboard: Dashboard, id: string, value: unknown) {
  const { direction, commitMessage, ...input } = check(bulkSchema, value);
  await requireGroup(dashboard, id);
  return toPreview(
    await dashboard.groups.preview(id, {
      ...input,
      intent: direction === 'pull' ? 'refresh' : 'restore',
      ...(direction === 'push' && commitMessage ? { commitMessage } : {}),
    }),
  );
}

/* ---------- Commit export ---------- */
async function commitPage(
  dashboard: Dashboard,
  repoId: string,
  id: string,
  query: URLSearchParams,
) {
  const { offset, ref } = check(commitsQuerySchema, Object.fromEntries(query));
  const commits = await dashboard.sync.exportCommits(repoId, id, offset ?? 0, ref);
  const { snapshot } = await dashboard.sync.workspaceTarget(repoId, id);
  const root = snapshot.data.source.path;
  const facts = new Map<string, { when: string; files: number }>();
  if (commits.length) {
    const log = await runGit(root, [
      'log',
      '--no-walk=unsorted',
      '--name-only',
      '--format=%x01%H%x00%cI',
      ...commits.map((commit) => commit.id),
      '--',
    ]).catch(() => '');
    for (const block of log.split('\x01').slice(1)) {
      const [head = '', ...files] = block.split('\n').filter(Boolean);
      const [sha = '', when = ''] = head.split('\0');
      facts.set(sha, { when, files: files.length });
    }
  }
  return commits.map((commit) => ({
    sha: commit.id,
    subject: commit.subject,
    when: facts.get(commit.id)?.when ?? '',
    files: facts.get(commit.id)?.files ?? 0,
  }));
}

export const homeRoutes: Route[] = [
  /* Workspace detail and actions */
  route('GET /api/v2/workspaces/:repoId/:id', (context) => {
    const { repoId, id } = workspaceParams(context);
    return workspaceDetail(context.dashboard, repoId, id);
  }),
  route('POST /api/v2/workspaces/:repoId/:id/pull', async (context) => {
    const { repoId, id } = workspaceParams(context);
    const { target } = check(pullTargetSchema, await context.body());
    return pullPreview(context.dashboard, repoId, id, target);
  }),
  route('POST /api/v2/workspaces/:repoId/:id/push', async (context) => {
    const { repoId, id } = workspaceParams(context);
    const { target } = check(pushTargetSchema, await context.body());
    return pushPreview(context.dashboard, repoId, id, target);
  }),
  route('POST /api/v2/workspaces/:repoId/:id/open', async (context) => {
    const { repoId, id } = workspaceParams(context);
    const body = check(desktopSchema, await context.body());
    await context.dashboard.desktop.openWorkspace(repoId, id, body);
    return { opened: true as const };
  }),
  route('DELETE /api/v2/workspaces/:repoId/:id', async (context) => {
    const { repoId, id } = workspaceParams(context);
    const body = check(
      z.object({ path: pathSchema, confirm: z.literal(true) }).strict(),
      await context.body(),
    );
    const result = await context.dashboard.deleteWorkspace(repoId, id, body);
    return { deleted: result.deleted };
  }),
  route('GET /api/v2/desktop', ({ dashboard }) => dashboard.desktop.availability()),
  /* Commit export */
  route('GET /api/v2/workspaces/:repoId/:id/export/commits', (context) => {
    const { repoId, id } = workspaceParams(context);
    return commitPage(context.dashboard, repoId, id, context.query);
  }),
  route('POST /api/v2/workspaces/:repoId/:id/export/files', async (context) => {
    const { repoId, id } = workspaceParams(context);
    const body = check(z.object({ commit: shaSchema }).strict(), await context.body());
    const { files } = await context.dashboard.sync.exportFiles(repoId, id, body);
    return { files };
  }),
  route('POST /api/v2/workspaces/:repoId/:id/export/diff', async (context) => {
    const { repoId, id } = workspaceParams(context);
    const body = check(
      z
        .object({
          commit: shaSchema,
          indexes: z.array(z.number().int().min(0).max(4999)).max(100),
          includeExcluded: z.boolean().optional(),
        })
        .strict(),
      await context.body(),
    );
    const { patch } = await context.dashboard.sync.exportDiff(repoId, id, body);
    return { patch };
  }),
  /* Groups */
  route('GET /api/v2/groups', async ({ dashboard }) => {
    const groups = await dashboard.groups.list();
    const [overview, events] = await Promise.all([
      dashboard.shell.overview({}),
      auditEvents(dashboard),
    ]);
    return {
      groups: await Promise.all(
        groups.map((group) => describeGroup(dashboard, group, overview, events)),
      ),
    };
  }),
  route('POST /api/v2/groups', async ({ dashboard, body }) => {
    const input = check(groupSaveSchema, await body());
    const group = await dashboard.groups.save(input);
    return groupView(dashboard, group.id);
  }),
  route('GET /api/v2/groups/:id', ({ dashboard, params }) =>
    groupView(dashboard, check(uuidSchema, params.id)),
  ),
  route('PUT /api/v2/groups/:id', async ({ dashboard, params, body }) => {
    const id = check(uuidSchema, params.id);
    const { revision, group } = check(
      z.object({ revision: z.string().min(1).max(200), group: groupSaveSchema }).strict(),
      await body(),
    );
    await dashboard.groups.save(group, id, revision);
    return groupView(dashboard, id);
  }),
  route('DELETE /api/v2/groups/:id', async ({ dashboard, params, body }) => {
    const { revision } = check(revisionSchema, await body());
    return dashboard.groups.remove(check(uuidSchema, params.id), revision);
  }),
  route('POST /api/v2/groups/:id/members', async ({ dashboard, params, body }) => {
    const id = check(uuidSchema, params.id);
    const input = check(
      z.object({ revision: z.string().min(1).max(200), member: groupMemberSchema }).strict(),
      await body(),
    );
    await dashboard.groups.join(id, input);
    return groupView(dashboard, id);
  }),
  route('POST /api/v2/groups/:id/open', async ({ dashboard, params, body }) => {
    await dashboard.desktop.openGroup(
      check(uuidSchema, params.id),
      check(desktopSchema, await body()),
    );
    return { opened: true as const };
  }),
  route('POST /api/v2/groups/:id/bulk', async ({ dashboard, params, body }) =>
    bulk(dashboard, check(uuidSchema, params.id), await body()),
  ),
  route('GET /api/v2/group-operations/:id', ({ dashboard, params }) =>
    batchStatusView(dashboard, check(uuidSchema, params.id)),
  ),
  route('POST /api/v2/group-operations/:id/apply', async ({ dashboard, params, body }) => {
    const id = check(uuidSchema, params.id);
    await dashboard.groups.apply(id, check(groupAckSchema, await body()));
    return batchStatusView(dashboard, id);
  }),
  route('POST /api/v2/group-operations/:id/retry', async ({ dashboard, params }) => {
    const batch = await dashboard.groups.retry(check(uuidSchema, params.id));
    return batchStatusView(dashboard, batch.operationId);
  }),
  route('DELETE /api/v2/group-operations/:id', ({ dashboard, params }) => {
    const id = check(uuidSchema, params.id);
    dashboard.groups.cancel(id);
    return batchStatusView(dashboard, id);
  }),
];
