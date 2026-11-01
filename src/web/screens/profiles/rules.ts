import type { ProfileRuleKind } from '../../api/contracts.js';

/** The stored engine document. Unknown fields are kept: rules and profiles are loose objects. */
export type RuleDoc = {
  id: string;
  type: 'literal' | 'regex' | 'secret';
  match?: string;
  replace?: string;
  flags?: string;
  detector?: string;
  styles?: unknown;
  [key: string]: unknown;
};
export type ProfileDoc = {
  kind: 'profile';
  schemaVersion: 1;
  name: string;
  description?: string;
  rules: RuleDoc[];
  include?: string[];
  exclude?: string[];
  extensions?: Record<string, unknown>;
  [key: string]: unknown;
};
export type CaseMode = 'preserve' | 'exact' | 'custom' | 'reversible' | 'sealed';
export type RuleRow = {
  id: string;
  kind: ProfileRuleKind;
  find: string;
  replace: string;
  flags: string;
  detector: string;
  caseMode: CaseMode;
};

export const kindLabels: Record<ProfileRuleKind, string> = {
  brand: 'Brand',
  keyword: 'Keyword',
  term: 'Business term',
  regex: 'Regex',
  secret: 'Secret',
};
export const ruleKinds = Object.keys(kindLabels) as ProfileRuleKind[];

/** Mirrors core/secrets.ts so the browser bundle stays free of it; a test keeps them in step. */
export const secretDetectorOptions = [
  { id: 'aws-access-key', name: 'AWS access key' },
  { id: 'aws-secret-key', name: 'AWS secret key' },
  { id: 'private-key', name: 'Private key' },
  { id: 'api-key', name: 'API key or token' },
  { id: 'password', name: 'Password' },
  { id: 'jwt', name: 'JSON web token' },
  { id: 'github-token', name: 'GitHub token' },
  { id: 'slack-token', name: 'Slack token' },
  { id: 'slack-webhook', name: 'Slack webhook' },
  { id: 'stripe-key', name: 'Stripe key' },
  { id: 'google-api-key', name: 'Google API key' },
  { id: 'google-oauth-token', name: 'Google OAuth token' },
  { id: 'discord-token', name: 'Discord bot token' },
  { id: 'discord-webhook', name: 'Discord webhook' },
  { id: 'database-url', name: 'Database connection URL' },
  { id: 'heroku-key', name: 'Heroku API key' },
  { id: 'mailgun-key', name: 'Mailgun API key' },
];

/*
 * The engine knows literal, regex and secret. Brand, keyword and business term are labels on a
 * literal, kept in extensions.ruleKinds so they never change what a rule does or how two
 * profiles merge. "exact" has no literal form, so it is a token-bounded regex that the form
 * recognises and shows as plain text again.
 */
const before = '(?<![A-Za-z0-9_])';
const after = '(?![A-Za-z0-9_])';
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
export const exactPattern = (text: string) => `${before}${escapePattern(text)}${after}`;
const exactReplace = (text: string) => text.replaceAll('$', '$$$$');

function readExact(rule: RuleDoc): { find: string; replace: string } | undefined {
  const match = rule.match ?? '';
  if (rule.type !== 'regex' || rule.flags || !match.startsWith(before) || !match.endsWith(after))
    return undefined;
  const find = match.slice(before.length, -after.length).replace(/\\(.)/g, '$1');
  if (exactPattern(find) !== match) return undefined;
  const raw = rule.replace ?? '';
  if (/\$(?!\$)/.test(raw.replaceAll('$$', ''))) return undefined;
  return { find, replace: raw.replaceAll('$$', '$') };
}

function labels(doc: ProfileDoc): Record<string, unknown> {
  const stored = doc.extensions?.ruleKinds;
  return stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
}
function labelOf(doc: ProfileDoc, id: string, fallback: ProfileRuleKind): ProfileRuleKind {
  const value = labels(doc)[id];
  return value === 'brand' || value === 'keyword' || value === 'term' ? value : fallback;
}

export function rowOf(doc: ProfileDoc, rule: RuleDoc): RuleRow {
  const base = {
    id: rule.id,
    find: rule.match ?? '',
    replace: rule.replace ?? '',
    flags: rule.flags ?? '',
    detector: rule.detector ?? '',
  };
  if (rule.type === 'secret') return { ...base, kind: 'secret', caseMode: 'sealed' };
  if (rule.type === 'regex') {
    const exact = readExact(rule);
    return exact
      ? { ...base, ...exact, kind: labelOf(doc, rule.id, 'keyword'), caseMode: 'exact' }
      : { ...base, kind: 'regex', caseMode: 'reversible' };
  }
  const custom = Array.isArray(rule.styles);
  return {
    ...base,
    kind: labelOf(doc, rule.id, 'brand'),
    caseMode: custom ? 'custom' : 'preserve',
  };
}

/** Writes a row back, keeping fields the form does not show (enabled, scope, boundary...). */
function ruleFrom(row: RuleRow, previous: RuleDoc): RuleDoc {
  if (row.kind === 'secret') {
    const { match, replace, flags, styles, ...rest } = previous;
    void match;
    void replace;
    void flags;
    void styles;
    return { ...rest, type: 'secret', detector: row.detector };
  }
  if (row.kind === 'regex' || row.caseMode === 'exact') {
    const { styles, detector, boundary, forms, except, common, ...rest } = previous;
    void styles;
    void detector;
    void boundary;
    void forms;
    void except;
    void common;
    if (row.kind === 'regex') {
      const { flags, ...noFlags } = rest;
      void flags;
      return {
        ...noFlags,
        type: 'regex',
        match: row.find,
        replace: row.replace,
        ...(row.flags ? { flags: row.flags } : {}),
      };
    }
    const { flags, ...noFlags } = rest;
    void flags;
    return {
      ...noFlags,
      type: 'regex',
      match: row.find ? exactPattern(row.find) : '',
      replace: row.replace ? exactReplace(row.replace) : '',
    };
  }
  const { flags, detector, ...rest } = previous;
  void flags;
  void detector;
  if (row.caseMode === 'preserve') delete rest.styles;
  return { ...rest, type: 'literal', match: row.find, replace: row.replace };
}

function withLabels(doc: ProfileDoc, next: Record<string, ProfileRuleKind>): ProfileDoc {
  const { ruleKinds: _old, ...extensions } = doc.extensions ?? {};
  void _old;
  const merged = Object.keys(next).length ? { ...extensions, ruleKinds: next } : extensions;
  const { extensions: _gone, ...rest } = doc;
  void _gone;
  return Object.keys(merged).length ? { ...rest, extensions: merged } : (rest as ProfileDoc);
}
function currentLabels(doc: ProfileDoc): Record<string, ProfileRuleKind> {
  const result: Record<string, ProfileRuleKind> = {};
  for (const rule of doc.rules) {
    const value = labels(doc)[rule.id];
    if (value === 'brand' || value === 'keyword' || value === 'term') result[rule.id] = value;
  }
  return result;
}

export function updateRow(doc: ProfileDoc, id: string, patch: Partial<RuleRow>): ProfileDoc {
  const rules = doc.rules.map((rule) => {
    if (rule.id !== id) return rule;
    return ruleFrom({ ...rowOf(doc, rule), ...patch }, rule);
  });
  return withLabels({ ...doc, rules }, currentLabels(doc));
}

export function addRule(doc: ProfileDoc, kind: ProfileRuleKind, find = ''): ProfileDoc {
  let index = doc.rules.length + 1;
  while (doc.rules.some((rule) => rule.id === `${kind}-${index}`)) index += 1;
  const id = `${kind}-${index}`;
  const rule: RuleDoc =
    kind === 'secret'
      ? { id, type: 'secret', detector: 'api-key' }
      : { id, type: kind === 'regex' ? 'regex' : 'literal', match: find, replace: '' };
  const next = { ...doc, rules: [...doc.rules, rule] };
  return withLabels(
    next,
    kind === 'regex' || kind === 'secret'
      ? currentLabels(next)
      : { ...currentLabels(next), [id]: kind },
  );
}

export function removeRule(doc: ProfileDoc, id: string): ProfileDoc {
  const rules = doc.rules.filter((rule) => rule.id !== id);
  return withLabels({ ...doc, rules }, currentLabels({ ...doc, rules }));
}

/** The form can only draw a document with this shape; JSON mode can hold anything. */
export function asProfileDoc(value: unknown): ProfileDoc | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const doc = value as Record<string, unknown>;
  const list = (item: unknown) =>
    item === undefined || (Array.isArray(item) && item.every((entry) => typeof entry === 'string'));
  if (!Array.isArray(doc.rules) || !list(doc.exclude) || !list(doc.include)) return undefined;
  const fine = doc.rules.every(
    (rule: unknown) =>
      rule &&
      typeof rule === 'object' &&
      typeof (rule as RuleDoc).id === 'string' &&
      ['literal', 'regex', 'secret'].includes((rule as RuleDoc).type),
  );
  return fine ? (value as ProfileDoc) : undefined;
}

export const blankProfile = (): ProfileDoc => ({
  kind: 'profile',
  schemaVersion: 1,
  name: '',
  rules: [],
});

export type ExclusionPreset = { id: string; name: string; patterns: string[] };
export const exclusionPresets: ExclusionPreset[] = [
  { id: 'ef', name: 'EF Core: DbContext, Migrations', patterns: ['*DbContext.cs', 'Migrations/'] },
  { id: 'snapshots', name: 'Snapshots: *.snap, schema.json', patterns: ['*.snap', 'schema.json'] },
  {
    id: 'lockfiles',
    name: 'Lockfiles',
    patterns: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'poetry.lock'],
  },
  {
    id: 'env',
    name: 'Env & secrets: .env*, *.pfx',
    patterns: ['.env*', '*.pfx', '*.pem', '*.key'],
  },
  {
    id: 'infra',
    name: 'Infra: terraform, helm values',
    patterns: ['*.tfvars', 'terraform/', 'helm/'],
  },
];
export function presetActive(doc: ProfileDoc, preset: ExclusionPreset) {
  const have = new Set(doc.exclude ?? []);
  return preset.patterns.every((pattern) => have.has(pattern));
}
export function togglePreset(doc: ProfileDoc, preset: ExclusionPreset, on: boolean): ProfileDoc {
  const without = (doc.exclude ?? []).filter((pattern) => !preset.patterns.includes(pattern));
  return setList(doc, 'exclude', on ? [...without, ...preset.patterns] : without);
}
/** An empty list is left out, the way a hand-written profile would be. */
export function setList(doc: ProfileDoc, key: 'exclude' | 'include', value: string[]): ProfileDoc {
  const { [key]: _old, ...rest } = doc;
  void _old;
  return (value.length ? { ...rest, [key]: value } : rest) as ProfileDoc;
}
