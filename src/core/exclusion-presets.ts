/** One catalog of exclusion presets. Data only, because the browser bundle imports it too. */
export type ExclusionPreset = { id: string; name: string; patterns: string[] };

const catalog = {
  schemas: {
    id: 'schemas',
    name: 'Schemas & migrations',
    patterns: ['*.schema.json', '*.sql', 'migrations/', '*DbContext.cs'],
  },
  ef: {
    id: 'ef',
    name: 'EF Core: DbContext, Migrations',
    patterns: ['*DbContext.cs', 'Migrations/'],
  },
  snapshots: {
    id: 'snapshots',
    name: 'Snapshots: *.snap, schema.json',
    patterns: ['*.snap', 'schema.json'],
  },
  lockfiles: {
    id: 'lockfiles',
    name: 'Lockfiles',
    patterns: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock'],
  },
  env: { id: 'env', name: 'Env files', patterns: ['.env', '.env.*'] },
  keys: { id: 'keys', name: 'Keys & certificates', patterns: ['*.pem', '*.key', '*.p12', '*.pfx'] },
  secrets: {
    id: 'env',
    name: 'Env & secrets: .env*, *.pfx',
    patterns: ['.env*', '*.pfx', '*.pem', '*.key'],
  },
  infra: {
    id: 'infra',
    name: 'Infra: terraform, helm values',
    patterns: ['*.tfvars', 'terraform/', 'helm/'],
  },
} satisfies Record<string, ExclusionPreset>;

/** The first-run chips. Their ids are stored in the "Never pull" profile, so they stay stable. */
export const firstRunPresets: ExclusionPreset[] = [
  catalog.schemas,
  catalog.lockfiles,
  catalog.env,
  catalog.keys,
];
/** The chips a profile can toggle. A chip is on while all of its patterns are in the profile. */
export const profilePresets: ExclusionPreset[] = [
  catalog.ef,
  catalog.snapshots,
  catalog.lockfiles,
  catalog.secrets,
  catalog.infra,
];
