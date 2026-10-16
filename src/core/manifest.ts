import { z } from 'zod';
import { hashJson } from './hash.js';
import { ledgerSchema, validateLedger } from './ledger.js';
import { validateRelativePath } from './paths.js';
import type { SavedProfile } from './profiles.js';
import { documentSchema, ruleSchema } from './schemas.js';

export const plainManifestSchema = documentSchema.manifest.omit({ sealed: true });
export type PlainManifest = z.infer<typeof plainManifestSchema>;
const text = z.string().min(1);
export const profileRefSchema = z.looseObject({
  id: text,
  name: text,
  hash: text,
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('global') }),
    z.object({ kind: z.literal('repo'), repoId: text }),
  ]),
});
export const manifestDataSchema = z.looseObject({
  source: z.looseObject({ path: text, commonDir: text.optional() }),
  origin: z.looseObject({
    worktree: text,
    branch: z.string().nullable(),
    commit: z.string().nullable(),
    dirty: z.boolean(),
  }),
  target: z.looseObject({ branch: z.string().nullable() }),
  profiles: z.array(profileRefSchema),
  rules: z.array(ruleSchema),
  ledger: ledgerSchema,
  files: z.record(
    z.string(),
    z.looseObject({ path: text, sourceHash: text, executable: z.boolean().optional() }),
  ),
  pulls: z.array(
    z.looseObject({ id: text, commit: z.string().nullable(), branch: z.string().nullable() }),
  ),
});
export type ManifestData = z.infer<typeof manifestDataSchema>;
export type Snapshot = { plain: PlainManifest; data: ManifestData };

export function profileRefs(profiles: SavedProfile[]) {
  return profiles.map((saved) => ({
    id: saved.id,
    name: saved.profile.name,
    scope: saved.scope,
    hash: hashJson(saved.profile),
  }));
}
export function changedProfiles(profiles: SavedProfile[], previous?: Snapshot): string[] {
  if (!previous) return [];
  const current = profileRefs(profiles);
  if (hashJson(current) === hashJson(previous.data.profiles)) return [];
  const names = [
    ...new Set(
      [...current, ...previous.data.profiles]
        .filter((ref) => {
          const other = current.find(
            (item) => item.id === ref.id && hashJson(item.scope) === hashJson(ref.scope),
          );
          const old = previous.data.profiles.find(
            (item) => item.id === ref.id && hashJson(item.scope) === hashJson(ref.scope),
          );
          return !other || !old || other.hash !== old.hash;
        })
        .map((ref) => ref.name),
    ),
  ];
  return names.length ? names : ['profile order or selection'];
}
export function validateSnapshot(snapshot: Snapshot): Snapshot {
  const plain = plainManifestSchema.parse(snapshot.plain);
  const data = manifestDataSchema.parse(snapshot.data);
  validateLedger(data.ledger);
  for (const [path, file] of Object.entries(data.files)) {
    validateRelativePath(path);
    validateRelativePath(file.path);
  }
  for (const path of Object.keys(plain.files)) {
    validateRelativePath(path);
    if (!data.files[path]) throw new Error(`Manifest is missing original metadata for ${path}`);
  }
  if (Object.keys(data.files).some((path) => !plain.files[path]))
    throw new Error('Manifest file maps disagree');
  return { plain, data };
}
