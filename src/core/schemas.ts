import { z } from 'zod';

export const schemaVersions = { profile: 1, repo: 1, manifest: 2, config: 1 } as const;
export type DocumentKind = keyof typeof schemaVersions;
export const documentKinds = Object.keys(schemaVersions) as DocumentKind[];
const text = z.string().min(1);
const extensions = z.record(z.string(), z.unknown()).optional();
const base = { $schema: z.string().optional(), extensions };
const ruleBase = {
  id: text,
  enabled: z.boolean().optional(),
  scope: z
    .union([z.enum(['content', 'paths']), z.array(z.enum(['content', 'paths'])).min(1)])
    .optional(),
};
export const ruleSchema = z.discriminatedUnion('type', [
  z.looseObject({
    ...ruleBase,
    type: z.literal('literal'),
    match: text,
    replace: text,
    boundary: z.enum(['token', 'word', 'anywhere']).optional(),
    styles: z
      .union([
        z.literal('all'),
        z
          .array(
            z.enum([
              'lower',
              'upper',
              'title',
              'pascal',
              'camel',
              'snake',
              'screaming',
              'kebab',
              'dot',
              'spaced',
              'smushed',
            ]),
          )
          .min(1),
      ])
      .optional(),
    forms: z.array(text).optional(),
    except: z.array(text).optional(),
    common: z.boolean().optional(),
  }),
  z.looseObject({
    ...ruleBase,
    type: z.literal('regex'),
    match: text,
    replace: z.string(),
    flags: z.string().optional(),
  }),
  z.looseObject({ ...ruleBase, type: z.literal('secret'), detector: text }),
]);
export const sealedSchema = z.looseObject({
  alg: z.literal('A256GCM'),
  keyId: text,
  nonce: text,
  data: text,
});
export type Sealed = z.infer<typeof sealedSchema>;
const worktree = z.looseObject({
  worktree: text,
  branch: z.string().nullable(),
  commit: text.nullable(),
});
const workspace = z.looseObject({
  path: text,
  createdAt: z.iso.datetime({ offset: true }),
  lastUsedAt: z.iso.datetime({ offset: true }),
  useCount: z.number().int().nonnegative(),
  lastProfiles: z.array(text),
  origin: worktree.extend({ dirty: z.boolean() }).optional(),
  target: worktree.nullable().optional(),
});
export const documentSchema = {
  profile: z.looseObject({
    ...base,
    kind: z.literal('profile'),
    schemaVersion: z.literal(1),
    name: text,
    description: z.string().optional(),
    rules: z.array(ruleSchema),
    include: z.array(text).optional(),
    exclude: z.array(text).optional(),
  }),
  repo: z.looseObject({
    ...base,
    kind: z.literal('repo'),
    schemaVersion: z.literal(1),
    repoId: z.string().regex(/^[a-f0-9]{16}$/),
    path: text,
    workspaces: z.record(z.string(), workspace),
  }),
  config: z.looseObject({
    ...base,
    kind: z.literal('config'),
    schemaVersion: z.literal(1),
    workspacesRoot: text.optional(),
    worktreePath: text.optional(),
    initGit: z.boolean().optional(),
    concurrency: z.number().int().positive().optional(),
  }),
  manifest: z.looseObject({
    ...base,
    kind: z.literal('manifest'),
    schemaVersion: z.literal(2),
    tool: z.looseObject({ name: z.literal('repo-cloak'), version: text }),
    workspaceId: text,
    source: z.looseObject({ repoId: z.string().regex(/^[a-f0-9]{16}$/) }),
    files: z.record(
      z.string(),
      z.looseObject({ hash: text, size: z.number().int().nonnegative(), binary: z.boolean() }),
    ),
    pulls: z.array(
      z.looseObject({
        id: text,
        at: z.iso.datetime({ offset: true }),
        toolVersion: text,
        selection: z.looseObject({
          files: z.number().int().nonnegative(),
          commits: z.number().int().nonnegative(),
          working: z.boolean(),
          extra: z.number().int().nonnegative(),
        }),
      }),
    ),
    sealed: sealedSchema,
  }),
};
export type Document<K extends DocumentKind> = z.infer<(typeof documentSchema)[K]>;
export type Rule = z.infer<typeof ruleSchema>;
export type Migration = (value: Record<string, unknown>) => Record<string, unknown>;
export type Migrations = Readonly<Record<number, Migration>>;

/** Validate headers before decryption; never interpret a newer format. */
export function checkVersion(
  kind: DocumentKind,
  value: unknown,
  source: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${source}: expected a ${kind} document`);
  const doc = value as Record<string, unknown>;
  if (doc.kind !== kind)
    throw new Error(`${source}: expected kind ${kind}, received ${String(doc.kind)}`);
  if (!Number.isInteger(doc.schemaVersion) || (doc.schemaVersion as number) < 0)
    throw new Error(`${source}: invalid schemaVersion`);
  if ((doc.schemaVersion as number) > schemaVersions[kind])
    throw new Error(
      `${source}: schemaVersion ${String(doc.schemaVersion)} is newer than supported ${schemaVersions[kind]}; upgrade repo-cloak`,
    );
  return doc;
}

export function parseDocument<K extends DocumentKind>(
  kind: K,
  value: unknown,
  source = kind as string,
  migrations: Migrations = {},
): Document<K> {
  let doc = checkVersion(kind, value, source);
  while ((doc.schemaVersion as number) < schemaVersions[kind]) {
    const version = doc.schemaVersion as number;
    const migrate = migrations[version];
    if (!migrate) throw new Error(`${source}: no ${kind} migration from schemaVersion ${version}`);
    doc = checkVersion(kind, migrate(doc), source);
    if ((doc.schemaVersion as number) <= version)
      throw new Error(`${source}: migration must advance schemaVersion`);
  }
  const result = documentSchema[kind].safeParse(doc);
  if (!result.success) throw new Error(`${source}: invalid ${kind}: ${result.error.message}`);
  return result.data as Document<K>;
}

export function jsonSchema(kind: DocumentKind) {
  return {
    ...z.toJSONSchema(documentSchema[kind]),
    $id: `https://unpkg.com/repo-cloak-cli@2/schemas/${kind}.schema.json`,
  };
}
