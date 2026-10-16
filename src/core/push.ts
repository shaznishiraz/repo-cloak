import { ConflictError } from './errors.js';
import { hashBytes } from './hash.js';
import type { Snapshot } from './manifest.js';
import type { FileWrite, SourceFile } from './pull.js';
import { checkPathCollisions, restorePaths } from './paths.js';
import { createReplacer } from './replacer.js';
import type { PreviewMatch } from './ledger.js';

export type PushOptions = { force?: boolean; skipConflicts?: boolean };

/** Restore a complete snapshot in memory before any source file can be touched. */
export function planPush(
  previous: Snapshot,
  workspace: SourceFile[],
  source: SourceFile[],
  options: PushOptions = {},
) {
  if (options.force && options.skipConflicts)
    throw new Error('--force and --skip-conflicts cannot be combined');
  const replacer = createReplacer(previous.data.rules);
  const current = new Map(
    workspace.filter((file) => file.bytes !== undefined).map((file) => [file.path, file]),
  );
  const sources = new Map(source.map((file) => [file.path, file]));
  const added = [...current.keys()].filter((path) => !Object.hasOwn(previous.plain.files, path));
  const restored = restorePaths(added, replacer, previous.data.ledger);
  const mapping = new Map([
    ...Object.entries(previous.data.files).map(([path, file]) => [path, file.path] as const),
    ...restored.paths.map((path) => [path.anonymized, path.original] as const),
  ]);
  checkPathCollisions(
    [...mapping].map(([anonymized, original]) => ({ anonymized, original })),
    true,
  );
  const publicFiles = new Map(Object.entries(previous.plain.files));
  const privateFiles = new Map(Object.entries(previous.data.files));
  const writes: FileWrite[] = [];
  const deletes: string[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const preview: PreviewMatch[] = [...restored.preview];
  for (const [path, original] of mapping) {
    const file = current.get(path);
    const baseline = Object.hasOwn(previous.plain.files, path)
      ? previous.plain.files[path]
      : undefined;
    if (file?.bytes && baseline && hashBytes(file.bytes) === baseline.hash) continue;
    if (!file && !baseline) continue;
    const target = sources.get(original);
    const old = Object.hasOwn(previous.data.files, path) ? previous.data.files[path] : undefined;
    let bytes: Uint8Array | undefined;
    if (file?.bytes) {
      if (file.binary) {
        bytes = file.bytes;
        warnings.push(`${path}: binary file copied unchanged`);
      } else {
        if (file.text === undefined) throw new Error(`${path}: missing decoded contents`);
        const result = replacer.restore(file.text, previous.data.ledger, {
          file: path,
          scope: 'content',
        });
        bytes = Buffer.from(result.text);
        preview.push(...result.preview);
      }
    }
    const sourceChanged = old
      ? target?.bytes === undefined ||
        hashBytes(target.bytes) !== old.sourceHash ||
        target.executable !== (old.executable ?? false)
      : target?.bytes !== undefined;
    const executable = old?.executable ?? file?.executable ?? false;
    const alreadyApplied =
      bytes === undefined
        ? target?.bytes === undefined
        : target?.bytes !== undefined &&
          hashBytes(target.bytes) === hashBytes(bytes) &&
          target.executable === executable;
    if (sourceChanged && !alreadyApplied && !options.force) {
      conflicts.push(path);
      continue;
    }
    if (bytes !== undefined && file?.bytes) {
      if (!alreadyApplied) writes.push({ path: original, bytes, executable });
      publicFiles.set(path, {
        ...baseline,
        hash: hashBytes(file.bytes),
        size: file.bytes.length,
        binary: file.binary,
      });
      privateFiles.set(path, { ...old, path: original, sourceHash: hashBytes(bytes), executable });
    } else {
      if (target?.bytes !== undefined) deletes.push(original);
      publicFiles.delete(path);
      privateFiles.delete(path);
    }
  }
  if (conflicts.length && !options.skipConflicts)
    throw new ConflictError(
      `Source files changed since extraction: ${conflicts.join(', ')}; no files were written`,
    );
  return {
    plain: { ...previous.plain, files: Object.fromEntries(publicFiles) },
    data: { ...previous.data, files: Object.fromEntries(privateFiles) },
    writes,
    deletes,
    conflicts,
    preview,
    warnings,
    profileChanges: [] as string[],
    previousRules: previous.data.rules,
  };
}
export type PushPlan = ReturnType<typeof planPush>;
