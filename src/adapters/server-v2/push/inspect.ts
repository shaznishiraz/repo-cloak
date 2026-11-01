import { join } from 'node:path';
import { instructionFiles, stripAgentGuidance } from '../../../core/agent-guidance.js';
import { hashBytes } from '../../../core/hash.js';
import type { Ledger, PreviewMatch } from '../../../core/ledger.js';
import { restorePaths } from '../../../core/paths.js';
import type { SourceFile } from '../../../core/pull.js';
import { createReplacer } from '../../../core/replacer.js';
import { workspaceStatus } from '../../../core/status.js';
import type { Dashboard } from '../../../application/dashboard.js';
import type { PushFile } from '../../../web/api/contracts.js';
import { exists, readSourceFiles } from '../../files.js';
import { runGit, runGitBytes } from '../../git.js';
import { createStatusIO } from '../../status.js';
import { concurrency } from './state.js';

export type RestoredFile = {
  cloaked: string;
  restoredPath: string;
  status: PushFile['status'];
  file?: SourceFile;
  /** Absent for a deletion. */
  bytes?: Uint8Array;
  text?: string;
  preview: PreviewMatch[];
};
export type Inspection = Awaited<ReturnType<typeof inspect>>;
export type Baseline = { cloaked: string; restored: string; restoredBytes?: Uint8Array };

export async function inspect(dashboard: Dashboard, repoId: string, workspaceId: string) {
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
export async function readOne(root: string, path: string) {
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
export async function baselineOf(
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
