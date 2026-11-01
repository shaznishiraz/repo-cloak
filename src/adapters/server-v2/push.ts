import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { lock } from 'proper-lockfile';
import { z } from 'zod';
import { instructionFiles, stripAgentGuidance } from '../../core/agent-guidance.js';
import { hashBytes, hashJson } from '../../core/hash.js';
import type { Ledger, PreviewMatch } from '../../core/ledger.js';
import type { Snapshot } from '../../core/manifest.js';
import { restorePaths, validateRelativePath } from '../../core/paths.js';
import type { SourceFile } from '../../core/pull.js';
import { createReplacer } from '../../core/replacer.js';
import { workspaceStatus } from '../../core/status.js';
import type {
  DiffLine,
  GuardCheck,
  PushApply,
  PushBackup,
  PushFile,
  PushFileFlag,
  PushReview,
  PushTarget,
} from '../../web/api/contracts.js';
import type { Dashboard } from '../../application/dashboard.js';
import { writeAtomic } from '../atomic.js';
import {
  canonicalPath,
  checkDestinationPath,
  checkSourceDestination,
  exists,
  readSourceFiles,
} from '../files.js';
import { repoState, resolveRepo, runGit, runGitBytes } from '../git.js';
import { createStatusIO } from '../status.js';
import { OperationError } from '../ui-operations.js';
import type { PreparedOperation, SyncResult } from '../ui-operations.js';
import { RequestError, route } from './router.js';
import type { Route } from './router.js';

const exec = promisify(execFile);
const dayMs = 24 * 60 * 60 * 1000;
const backupDays = 7;
const concurrency = 16;
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
const backupIdSchema = z.string().uuid();
const backupIndexSchema = z.object({
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
    }),
  ),
});
type BackupIndex = z.infer<typeof backupIndexSchema>;
type Options = Omit<PushApply, 'operationId' | 'commitMessage'> & { message: string | undefined };
const defaultOptions: Options = {
  mode: 'write',
  message: undefined,
  repull: false,
  includeGroupMembers: false,
  mergeMode: 'merge',
};
type Pending = {
  repoId: string;
  workspaceId: string;
  /** Restored path to merged bytes, or null when the two sides overlap. */
  merges: Map<string, Uint8Array | null>;
  options: Options;
};

/** Each dashboard keeps its own previews; they die with the operation they belong to. */
const pendingByDashboard = new WeakMap<Dashboard, Map<string, Pending>>();
function pendingFor(dashboard: Dashboard) {
  let pending = pendingByDashboard.get(dashboard);
  if (!pending) pendingByDashboard.set(dashboard, (pending = new Map()));
  return pending;
}

/* ---------- Text helpers ---------- */
function linesOf(text: string) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
type DiffOp = { kind: DiffLine['kind']; before: number; after: number };
/** Longest common subsequence after trimming; huge middles degrade to one replaced block. */
function diffLines(before: string[], after: string[]): DiffOp[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endA = before.length;
  let endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: 'context', before: i, after: i });
  const rows = endA - start;
  const columns = endB - start;
  if (rows * columns > 4_000_000) {
    for (let i = start; i < endA; i++) ops.push({ kind: 'remove', before: i, after: start });
    for (let j = start; j < endB; j++) ops.push({ kind: 'add', before: endA, after: j });
  } else {
    const width = columns + 1;
    const table = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--)
      for (let j = columns - 1; j >= 0; j--)
        table[i * width + j] =
          before[start + i] === after[start + j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    let i = 0;
    let j = 0;
    while (i < rows || j < columns) {
      if (i < rows && j < columns && before[start + i] === after[start + j]) {
        ops.push({ kind: 'context', before: start + i, after: start + j });
        i++;
        j++;
      } else if (
        j < columns &&
        (i === rows || (table[i * width + j + 1] ?? 0) > (table[(i + 1) * width + j] ?? 0))
      ) {
        ops.push({ kind: 'add', before: start + i, after: start + j });
        j++;
      } else {
        ops.push({ kind: 'remove', before: start + i, after: start + j });
        i++;
      }
    }
  }
  for (let i = endA, j = endB; i < before.length; i++, j++)
    ops.push({ kind: 'context', before: i, after: j });
  return ops;
}
function changedRange(before: string, after: string) {
  const lines = diffLines(linesOf(before), linesOf(after))
    .filter((op) => op.kind !== 'context')
    .map((op) => op.after + 1);
  if (!lines.length) return undefined;
  const [first, last] = [Math.min(...lines), Math.max(...lines)];
  return first === last ? `line ${first}` : `lines ${first}–${last}`;
}
/** Diffs never show real secrets: what restores from a placeholder stays masked on screen. */
function maskSecrets(text: string, ledger: Ledger) {
  let masked = text;
  for (const entry of ledger)
    if (entry.kind === 'secret' && entry.scope === 'content')
      masked = masked.replaceAll(entry.original, '[secret]');
  return masked;
}
function wordAround(text: string, start: number, end: number) {
  const word = /[\p{L}\p{N}_]/u;
  let from = start;
  let to = end;
  while (from > 0 && word.test(text[from - 1] ?? '')) from--;
  while (to < text.length && word.test(text[to] ?? '')) to++;
  return text.slice(from, to);
}

/* ---------- Reading one workspace ---------- */
type RestoredFile = {
  cloaked: string;
  restoredPath: string;
  status: PushFile['status'];
  file?: SourceFile;
  /** Absent for a deletion. */
  bytes?: Uint8Array;
  text?: string;
  preview: PreviewMatch[];
};
type Inspection = Awaited<ReturnType<typeof inspect>>;
type Baseline = { cloaked: string; restored: string; restoredBytes?: Uint8Array };

async function inspect(dashboard: Dashboard, repoId: string, workspaceId: string) {
  const { path: workspace, snapshot } = await dashboard.sync.workspaceTarget(repoId, workspaceId);
  const io = createStatusIO(workspace);
  const status = workspaceStatus(
    snapshot.plain.files,
    await io.readFiles(workspace, Object.keys(snapshot.plain.files)),
  );
  const replacer = createReplacer(snapshot.data.rules);
  const ledger = snapshot.data.ledger;
  const present = [...status.modified, ...status.added];
  const read = await readSourceFiles(workspace, present, concurrency);
  const contents = new Map(read.files.map((file) => [file.path, file]));
  const problems: { path: string; message: string; leak: boolean }[] = read.warnings.map(
    (message) => ({ path: message.split(':')[0] ?? '', message, leak: false }),
  );
  const files: RestoredFile[] = [];
  const pathPreview = new Map<string, { segment: string; preview: PreviewMatch[] }[]>();
  for (const [paths, kind] of [
    [status.modified, 'modified'],
    [status.added, 'added'],
    [status.deleted, 'deleted'],
  ] as const) {
    for (const cloaked of paths) {
      let restoredPath = snapshot.data.files[cloaked]?.path ?? cloaked;
      try {
        if (kind === 'added') {
          restoredPath = restorePaths([cloaked], replacer, ledger).paths[0]?.original ?? cloaked;
          pathPreview.set(
            cloaked,
            cloaked.split('/').map((segment) => ({
              segment,
              preview: replacer.restore(segment, ledger, { file: cloaked, scope: 'paths' }).preview,
            })),
          );
        }
      } catch (error) {
        problems.push(problem(cloaked, error));
      }
      const entry: RestoredFile = { cloaked, restoredPath, status: kind, preview: [] };
      const file = contents.get(cloaked);
      if (file?.bytes) {
        entry.file = file;
        entry.bytes = file.bytes;
        if (!file.binary && file.text !== undefined) {
          const text =
            snapshot.data.guidance &&
            instructionFiles.includes(cloaked) &&
            !snapshot.data.guidance.generated.includes(cloaked)
              ? stripAgentGuidance(file.text)
              : file.text;
          try {
            const restored = replacer.restore(text, ledger, { file: cloaked, scope: 'content' });
            entry.text = restored.text;
            entry.bytes = Buffer.from(restored.text);
            entry.preview = restored.preview;
          } catch (error) {
            problems.push(problem(cloaked, error));
          }
        }
      }
      files.push(entry);
    }
  }
  return { workspace, snapshot, replacer, ledger, files, problems, pathPreview };
}
function problem(path: string, error: unknown) {
  const message = error instanceof Error ? error.message : 'Could not restore this file';
  return { path, message, leak: message.includes('anonymized text remains') };
}
async function readOne(root: string, path: string) {
  try {
    const { files } = await readSourceFiles(root, [path], 1);
    return files[0];
  } catch {
    return undefined;
  }
}
/**
 * What the file looked like when last synchronized. Nothing here is trusted until its hash matches
 * the manifest, so a moved branch or a rewritten workspace history cannot supply a false base.
 */
async function baselineOf(
  { workspace, snapshot, replacer, ledger }: Inspection,
  path: string,
): Promise<{ baseline?: Baseline; ledger: Ledger }> {
  const old = snapshot.data.files[path];
  const kept = snapshot.plain.files[path];
  if (!old || !kept) return { ledger };
  const content = { file: path, scope: 'content' } as const;
  if (await exists(join(workspace, '.git'))) {
    const history = await runGit(workspace, [
      '--literal-pathspecs',
      'rev-list',
      '-n',
      '32',
      'HEAD',
      '--',
      path,
    ]).catch(() => '');
    for (const commit of history.split('\n').filter(Boolean)) {
      const bytes = await runGitBytes(workspace, ['cat-file', 'blob', `${commit}:${path}`]).catch(
        () => undefined,
      );
      if (!bytes || hashBytes(bytes) !== kept.hash) continue;
      const cloaked = bytes.toString('utf8');
      try {
        const restored = Buffer.from(replacer.restore(cloaked, ledger, content).text);
        return {
          baseline: {
            cloaked,
            restored: restored.toString('utf8'),
            ...(hashBytes(restored) === old.sourceHash ? { restoredBytes: restored } : {}),
          },
          ledger,
        };
      } catch {
        break;
      }
    }
  }
  const fromSource = (bytes: Uint8Array) => {
    const restored = Buffer.from(bytes).toString('utf8');
    const result = replacer.anonymize(restored, content, ledger);
    return { baseline: { cloaked: result.text, restored }, ledger: result.ledger };
  };
  const roots = [...new Set([snapshot.data.source.path, snapshot.data.origin.worktree])];
  let approximate: { baseline: Baseline; ledger: Ledger } | undefined;
  for (const root of roots) {
    const file = await readOne(root, old.path);
    if (!file?.bytes || file.binary) continue;
    try {
      const found = fromSource(file.bytes);
      if (hashBytes(file.bytes) === old.sourceHash)
        return {
          baseline: { ...found.baseline, restoredBytes: file.bytes },
          ledger: found.ledger,
        };
      approximate ??= found;
    } catch {
      // A source that already contains a cloaked name cannot supply a baseline.
    }
    for (const commit of new Set([
      snapshot.data.pulls.at(-1)?.commit ?? null,
      snapshot.data.origin.commit,
    ])) {
      if (!commit) continue;
      const bytes = await runGitBytes(root, ['cat-file', 'blob', `${commit}:${old.path}`]).catch(
        () => undefined,
      );
      if (!bytes || hashBytes(bytes) !== old.sourceHash) continue;
      try {
        const found = fromSource(bytes);
        return { baseline: { ...found.baseline, restoredBytes: bytes }, ledger: found.ledger };
      } catch {
        break;
      }
    }
  }
  // Without a verified base the diff shows what would change against the source as it is now.
  return approximate ?? { ledger };
}

/* ---------- Merge ---------- */
/** git merge-file exits with the number of conflicts, so any failure means "not clean". */
async function mergeThree(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-cloak-merge-'));
  try {
    const [oursPath, basePath, theirsPath] = ['ours', 'base', 'theirs'].map((name) =>
      join(directory, name),
    ) as [string, string, string];
    await Promise.all([
      writeFile(oursPath, ours, { mode: 0o600 }),
      writeFile(basePath, base, { mode: 0o600 }),
      writeFile(theirsPath, theirs, { mode: 0o600 }),
    ]);
    const { stdout } = await exec('git', ['merge-file', '-p', oursPath, basePath, theirsPath], {
      cwd: directory,
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout as Uint8Array;
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function planMerges(inspection: Inspection, conflicts: string[], root: string) {
  const merges = new Map<string, Uint8Array | null>();
  const notes: GuardCheck[] = [];
  const head = await runGit(root, ['rev-parse', '--verify', 'HEAD']).catch(() => '');
  const pulled =
    inspection.snapshot.data.pulls.at(-1)?.commit ?? inspection.snapshot.data.origin.commit;
  for (const cloaked of conflicts) {
    const entry = inspection.files.find((file) => file.cloaked === cloaked);
    if (!entry) continue;
    const theirs = await readOne(root, entry.restoredPath);
    const { baseline } = await baselineOf(inspection, cloaked);
    const merged =
      entry.bytes &&
      !entry.file?.binary &&
      theirs?.bytes &&
      !theirs.binary &&
      baseline?.restoredBytes
        ? await mergeThree(baseline.restoredBytes, entry.bytes, theirs.bytes)
        : null;
    merges.set(entry.restoredPath, merged);
    let commit = '';
    if (pulled && head.trim() && pulled !== head.trim())
      commit = await runGit(root, [
        '--literal-pathspecs',
        'log',
        '-1',
        '--format=%h',
        `${pulled}..HEAD`,
        '--',
        entry.restoredPath,
      ])
        .then((value) => value.trim())
        .catch(() => '');
    const upstream =
      baseline?.restoredBytes && theirs?.text !== undefined
        ? changedRange(baseline.restored, theirs.text)
        : undefined;
    const yours =
      baseline?.restoredBytes && entry.text !== undefined
        ? changedRange(baseline.restored, entry.text)
        : undefined;
    const who = commit ? `Upstream commit ${commit}` : 'The source';
    const where = upstream ? `${who} touched ${upstream}.` : `${who} changed this file.`;
    const edit = yours ? `Your edit is at ${yours}` : 'Your edit';
    notes.push({
      id: `merge:${cloaked}`,
      state: merged ? 'info' : 'blocked',
      title: `${basename(entry.restoredPath)} changed in the source after you pulled`,
      detail: merged
        ? `${where} ${edit}, so a 3-way merge applies cleanly.`
        : `${where} ${edit}, and the two overlap or no base is available. Pull first, or overwrite the source.`,
    });
  }
  return { merges, notes };
}

/* ---------- Review ---------- */
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
async function review(
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

  const pending: Pending = { repoId, workspaceId, merges, options: defaultOptions };
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
      bytes: prepared.bytes + mergedBytes,
      apply: () => runPush(dashboard, inspection.workspace, pending, prepared, isNewTree),
    }),
  );
  all.set(preview.operationId, pending);
  return finish(files, preview.operationId, summary.canApply);
}

/* ---------- Backups ---------- */
async function commonDirOf(dashboard: Dashboard, repoId: string) {
  const main = (await dashboard.sync.worktrees(repoId))[0]?.path;
  if (!main) throw new OperationError('validation', 'The source repository is not available');
  return (await resolveRepo(main)).commonDir;
}
/**
 * Backups hold source bytes, so they live beside the source inside its Git directory: never in the
 * cloak, where an agent could read them, and never committed.
 */
function backupRoot(commonDir: string, workspaceId: string) {
  return { base: commonDir, relative: `repo-cloak-backups/${hashJson(workspaceId).slice(7, 39)}` };
}
async function saveBackup(
  commonDir: string,
  workspaceId: string,
  workspace: string,
  root: string,
  paths: string[],
) {
  const id = randomUUID();
  const { base, relative } = backupRoot(commonDir, workspaceId);
  const directory = join(base, relative, id);
  await checkDestinationPath(base, `${relative}/${id}`);
  const entries: { path: string; blob: string | null; mode: number | null }[] = [];
  for (const [index, path] of paths.entries()) {
    await checkSourceDestination(root, path);
    const target = join(root, ...path.split('/'));
    if (await exists(target)) {
      const blob = `f${index}`;
      await writeAtomic(join(directory, blob), await readFile(target));
      entries.push({ path, blob, mode: (await lstat(target)).mode & 0o777 });
    } else entries.push({ path, blob: null, mode: null });
  }
  await checkDestinationPath(workspace, '.repo-cloak/manifest.json');
  await writeAtomic(
    join(directory, 'manifest'),
    await readFile(join(workspace, '.repo-cloak', 'manifest.json')),
  );
  return {
    discard: () => rm(directory, { recursive: true, force: true }),
    /** Written last: a backup without an index was never finished and cannot be undone. */
    async finish() {
      const createdAt = new Date();
      const files = await Promise.all(
        entries.map(async (entry) => {
          const target = join(root, ...entry.path.split('/'));
          return {
            ...entry,
            after: (await exists(target)) ? hashBytes(await readFile(target)) : null,
          };
        }),
      );
      const index: BackupIndex = {
        id,
        workspaceId,
        root,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + backupDays * dayMs).toISOString(),
        manifestAfter: hashBytes(await readFile(join(workspace, '.repo-cloak', 'manifest.json'))),
        files,
      };
      await writeAtomic(join(directory, 'index.json'), JSON.stringify(index));
    },
  };
}
async function readBackups(commonDir: string, workspaceId: string) {
  const { base, relative } = backupRoot(commonDir, workspaceId);
  const parent = join(base, relative);
  const names = await readdir(parent).catch(() => [] as string[]);
  const backups: BackupIndex[] = [];
  for (const name of names) {
    const directory = join(parent, name);
    let index: BackupIndex | undefined;
    try {
      index = backupIndexSchema.parse(
        JSON.parse(await readFile(join(directory, 'index.json'), 'utf8')),
      );
    } catch {
      index = undefined;
    }
    // An unfinished or damaged backup is kept for the same window, then removed.
    const age = index
      ? Date.parse(index.expiresAt)
      : (await stat(directory).catch(() => undefined))?.mtimeMs;
    const expired = age === undefined || age + (index ? 0 : backupDays * dayMs) <= Date.now();
    if (expired) await rm(directory, { recursive: true, force: true });
    else if (index?.id === name && index.workspaceId === workspaceId) backups.push(index);
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function withLocks<T>(workspace: string, commonDir: string, action: () => Promise<T>) {
  const releaseWorkspace = await lock(workspace, { retries: 0 });
  try {
    const releaseSource = await lock(commonDir, { retries: 0 });
    try {
      return await action();
    } finally {
      await releaseSource();
    }
  } finally {
    await releaseWorkspace();
  }
}
async function undo(dashboard: Dashboard, repoId: string, workspaceId: string, backupId: string) {
  const { path: workspace } = await dashboard.sync.workspaceTarget(repoId, workspaceId);
  const commonDir = await commonDirOf(dashboard, repoId);
  const index = (await readBackups(commonDir, workspaceId)).find((item) => item.id === backupId);
  if (!index) throw new RequestError(404, 'This backup has expired or was already used');
  const trees = await Promise.all(
    (await dashboard.sync.worktrees(repoId)).map((tree) => canonicalPath(tree.path)),
  );
  if (!trees.includes(await canonicalPath(index.root)))
    throw new RequestError(409, 'The worktree this push went to no longer exists');
  const { base, relative } = backupRoot(commonDir, workspaceId);
  const directory = join(base, relative, backupId);
  return dashboard.sync.operations.exclusive(() =>
    withLocks(workspace, commonDir, async () => {
      const manifestPath = join(workspace, '.repo-cloak', 'manifest.json');
      await checkDestinationPath(workspace, '.repo-cloak/manifest.json');
      const moved = () =>
        new RequestError(
          409,
          'Files changed after this push, so undo would overwrite newer work. Nothing was changed.',
        );
      if (hashBytes(await readFile(manifestPath)) !== index.manifestAfter) throw moved();
      const plan: { path: string; target: string; bytes?: Buffer; mode: number | null }[] = [];
      for (const file of index.files) {
        const path = validateRelativePath(file.path);
        await checkSourceDestination(index.root, path);
        const target = join(index.root, ...path.split('/'));
        const present = await exists(target);
        const current = present ? hashBytes(await readFile(target)) : null;
        if (current !== file.after) throw moved();
        plan.push({
          path,
          target,
          mode: file.mode,
          ...(file.blob ? { bytes: await readFile(join(directory, file.blob)) } : {}),
        });
      }
      const manifest = await readFile(join(directory, 'manifest'));
      for (const item of plan) {
        if (item.bytes) {
          await writeAtomic(item.target, item.bytes);
          if (item.mode !== null && process.platform !== 'win32')
            await chmod(item.target, item.mode);
        } else await unlink(item.target).catch(() => {});
      }
      await writeAtomic(manifestPath, manifest);
      await rm(directory, { recursive: true, force: true });
      await dashboard.sync.audit.record({
        op: 'push',
        outcome: 'ok',
        workspace: { repoId, id: workspaceId, name: basename(workspace) },
        files: plan.map((item) => ({ path: item.path })),
        detail: 'Undid a push from its backup',
      });
      return { restored: plan.length };
    }),
  );
}

/* ---------- Apply ---------- */
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
async function runPush(
  dashboard: Dashboard,
  workspace: string,
  pending: Pending,
  prepared: PreparedOperation,
  isNewTree: boolean,
): Promise<SyncResult> {
  const { repoId, workspaceId, merges, options } = pending;
  const { summary } = prepared;
  const root = summary.destination.path;
  const commonDir = await commonDirOf(dashboard, repoId);
  const touched = [...new Set([...summary.writes, ...summary.deletes])];
  await readBackups(commonDir, workspaceId);
  const backup =
    isNewTree || !touched.length
      ? undefined
      : await saveBackup(commonDir, workspaceId, workspace, root, touched);
  let result: SyncResult;
  try {
    result = await prepared.apply();
  } catch (error) {
    await backup?.discard();
    throw error;
  }
  const warnings = [...result.warnings];
  const auditTarget = { repoId, id: workspaceId, name: basename(workspace) };
  if (options.mergeMode === 'merge' && merges.size) {
    try {
      const written = await withLocks(workspace, commonDir, async () => {
        const files: { path: string; hash: string }[] = [];
        for (const [path, bytes] of merges) {
          if (!bytes) throw new Error(`${path}: cannot be merged`);
          await checkSourceDestination(root, path);
          const target = join(root, ...path.split('/'));
          const mode = (await lstat(target)).mode & 0o777;
          await writeAtomic(target, bytes);
          if (process.platform !== 'win32') await chmod(target, mode);
          files.push({ path, hash: hashBytes(bytes) });
        }
        return files;
      });
      await dashboard.sync.audit.record({
        op: 'push',
        outcome: 'ok',
        workspace: auditTarget,
        files: written,
        detail: '3-way merge with upstream',
      });
    } catch (error) {
      await backup?.finish();
      throw new Error(
        `Your version landed but merging upstream changes failed; undo from the backup. ${describeError(error)}`,
        { cause: error },
      );
    }
  }
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
  await backup?.finish();
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
      await runPush(
        dashboard,
        target.path,
        {
          repoId: member.repoId,
          workspaceId: member.workspaceId,
          merges: new Map(),
          options: { ...options, message, includeGroupMembers: false },
        },
        prepared,
        false,
      );
      notes.push(`${name}: ${summary.writes.length} files pushed`);
    } catch (error) {
      notes.push(`${name}: not pushed: ${describeError(error)}`);
    }
  }
  return notes;
}

/* ---------- Routes ---------- */
function ids(params: Record<string, string>) {
  return {
    repoId: repoIdSchema.parse(params.repoId),
    workspaceId: workspaceIdSchema.parse(params.id),
  };
}
function restoredMessage(inspection: Inspection, message: string) {
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
    const backups = await readBackups(await commonDirOf(dashboard, repoId), workspaceId);
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
