import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { GuardCheck } from '../../../web/api/contracts.js';
import { runGit } from '../../git.js';
import { changedRange } from './diff.js';
import { baselineOf, readOne } from './inspect.js';
import type { Inspection } from './inspect.js';

const exec = promisify(execFile);

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
export async function planMerges(inspection: Inspection, conflicts: string[], root: string) {
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
