import { ConflictError } from './errors.js';
import { hashBytes } from './hash.js';
import type { PreviewMatch } from './ledger.js';
import { changedProfiles, profileRefs } from './manifest.js';
import type { ManifestData, PlainManifest, Snapshot } from './manifest.js';
import { mergeProfiles } from './merge.js';
import { anonymizePaths, checkPathCollisions } from './paths.js';
import type { SavedProfile } from './profiles.js';
import { createReplacer } from './replacer.js';

export type SourceFile = {
  path: string;
  bytes?: Uint8Array;
  text?: string;
  binary: boolean;
  executable: boolean;
};
export type RepoState = {
  repoId: string;
  path: string;
  commonDir?: string;
  branch: string | null;
  commit: string | null;
};
export type PullInput = {
  repo: RepoState;
  workspaceId: string;
  pullId: string;
  at: string;
  version: string;
  profiles: SavedProfile[];
  files: SourceFile[];
  workspace: Record<string, Uint8Array>;
  workspacePaths?: string[];
  previous?: Snapshot;
  selection: { files: number; commits: number; working: boolean; extra: number };
};
export type FileWrite = { path: string; bytes: Uint8Array; executable: boolean };

export function pullTargetPaths(
  files: SourceFile[],
  profiles: SavedProfile[],
  previous?: Snapshot,
): string[] {
  const replacer = createReplacer(mergeProfiles(profiles));
  const ledger = changedProfiles(profiles, previous).length ? [] : (previous?.data.ledger ?? []);
  return anonymizePaths(
    files.filter((file) => file.bytes).map((file) => file.path),
    replacer,
    ledger,
  ).paths.map((path) => path.anonymized);
}

export function planPull(input: PullInput) {
  const { previous, repo } = input;
  const profileChanges = changedProfiles(input.profiles, previous);
  const workspaceChanged = (path: string) => {
    const bytes = input.workspace[path];
    return !bytes || hashBytes(bytes) !== previous?.plain.files[path]?.hash;
  };
  if (profileChanges.length && previous) {
    if (Object.keys(previous.plain.files).some(workspaceChanged))
      throw new Error(
        'Profiles changed while workspace files are edited; restore or discard those edits before refreshing profiles',
      );
    const selected = new Set(input.files.map((file) => file.path));
    if (Object.values(previous.data.files).some((file) => !selected.has(file.path)))
      throw new Error('Profile changes require refreshing all tracked files');
  }
  const rules = mergeProfiles(input.profiles);
  const replacer = createReplacer(rules);
  const mapped = anonymizePaths(
    input.files.filter((file) => file.bytes).map((file) => file.path),
    replacer,
    profileChanges.length ? [] : (previous?.data.ledger ?? []),
  );
  let ledger = mapped.ledger;
  const paths = new Map(mapped.paths.map((path) => [path.original, path.anonymized]));
  const oldPaths = new Map(
    Object.entries(previous?.data.files ?? {}).map(([path, file]) => [file.path, path]),
  );
  const files = new Map(Object.entries(previous?.plain.files ?? {}));
  const originals = new Map(Object.entries(previous?.data.files ?? {}));
  const writes: FileWrite[] = [];
  const deletes: string[] = [];
  const warnings: string[] = [];
  const preview: PreviewMatch[] = [...mapped.preview];
  for (const file of input.files) {
    const oldPath = oldPaths.get(file.path);
    const old = oldPath ? previous?.data.files[oldPath] : undefined;
    const sourceHash = file.bytes ? hashBytes(file.bytes) : undefined;
    const sourceChanged =
      old && (sourceHash !== old.sourceHash || file.executable !== (old.executable ?? false));
    if (oldPath && workspaceChanged(oldPath)) {
      if (sourceChanged || profileChanges.length)
        throw new ConflictError(
          `${oldPath}: both source and workspace changed; no files were written`,
        );
      continue;
    }
    if (!file.bytes) {
      if (oldPath) {
        if (input.workspace[oldPath]) deletes.push(oldPath);
        files.delete(oldPath);
        originals.delete(oldPath);
      }
      continue;
    }
    const path = paths.get(file.path);
    if (!path) throw new Error(`Missing anonymized path for ${file.path}`);
    if (!oldPath && input.workspace[path])
      throw new Error(`${path}: refusing to overwrite an untracked workspace file`);
    let bytes = file.bytes;
    if (file.binary) warnings.push(`${path}: binary file copied unchanged`);
    else {
      if (file.text === undefined)
        throw new Error(`${file.path}: text file has no decoded contents`);
      const result = replacer.anonymize(file.text, { file: file.path, scope: 'content' }, ledger);
      bytes = Buffer.from(result.text);
      ledger = result.ledger;
      preview.push(...result.preview);
    }
    if (oldPath && oldPath !== path) {
      deletes.push(oldPath);
      files.delete(oldPath);
      originals.delete(oldPath);
    }
    const hash = hashBytes(bytes);
    if (!input.workspace[path] || hashBytes(input.workspace[path]) !== hash || sourceChanged)
      writes.push({ path, bytes, executable: file.executable });
    files.set(path, { ...files.get(path), hash, size: bytes.length, binary: file.binary });
    originals.set(path, {
      ...originals.get(path),
      path: file.path,
      sourceHash: sourceHash ?? '',
      executable: file.executable,
    });
  }
  const changes = [...originals].map(([anonymized, original]) => ({
    original: original.path,
    anonymized,
  }));
  checkPathCollisions(changes, false);
  for (const path of input.workspacePaths ?? Object.keys(input.workspace)) {
    if (deletes.includes(path) || previous?.plain.files[path]) continue;
    const key = path.normalize('NFC').toLowerCase();
    if (
      changes.some((change) => {
        const target = change.anonymized.normalize('NFC').toLowerCase();
        return key === target || key.startsWith(`${target}/`) || target.startsWith(`${key}/`);
      })
    )
      throw new Error(`${path}: untracked workspace path collision`);
  }
  const plain: PlainManifest = {
    ...previous?.plain,
    $schema: 'https://unpkg.com/repo-cloak-cli@2/schemas/manifest.schema.json',
    kind: 'manifest',
    schemaVersion: 2,
    tool: { name: 'repo-cloak', version: input.version },
    workspaceId: input.workspaceId,
    source: { repoId: repo.repoId },
    files: Object.fromEntries(files),
    pulls: [
      ...(previous?.plain.pulls ?? []),
      { id: input.pullId, at: input.at, selection: input.selection, toolVersion: input.version },
    ],
    extensions: previous?.plain.extensions ?? {},
  };
  const data: ManifestData = {
    ...previous?.data,
    source: { path: repo.path, ...(repo.commonDir ? { commonDir: repo.commonDir } : {}) },
    origin: {
      worktree: repo.path,
      branch: repo.branch,
      commit: repo.commit,
      dirty: input.selection.working,
    },
    target: previous?.data.target ?? { branch: repo.branch },
    profiles: profileRefs(input.profiles),
    rules,
    ledger,
    files: Object.fromEntries(originals),
    pulls: [
      ...(previous?.data.pulls ?? []),
      { id: input.pullId, commit: repo.commit, branch: repo.branch },
    ],
  };
  return {
    plain,
    data,
    writes,
    deletes: [...new Set(deletes)],
    preview,
    warnings,
    profileChanges,
    previousRules: previous?.data.rules ?? [],
  };
}
export type PullPlan = ReturnType<typeof planPull>;
