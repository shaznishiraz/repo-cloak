import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Dashboard } from '../../application/dashboard.js';
import { hashJson } from '../../core/hash.js';
import { compilePatterns } from '../../core/patterns.js';
import type { SavedProfile } from '../../core/profiles.js';
import { createReplacer } from '../../core/replacer.js';
import { validateProfile, validateRule } from '../../core/rules.js';
import type { Rule } from '../../core/rules.js';
import { documentKinds, documentSchema, jsonSchema, ruleSchema } from '../../core/schemas.js';
import { entropy, secretDetectors } from '../../core/secrets.js';
import { ruleWarnings } from '../../core/variants.js';
import type {
  LockedExclusion,
  ProfileDetail,
  ProfileListItem,
  ProfileProblem,
  ProfileSuggestion,
} from '../../web/api/contracts.js';
import { runGit, runGitBytes } from '../git.js';
import { RequestError, route } from './router.js';
import type { Route } from './router.js';

const repoId = z.string().regex(/^[a-f0-9]{16}$/);
const profileId = z
  .string()
  .regex(/^pf_[a-zA-Z0-9_-]+$/)
  .max(200);
const scopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('repo'), repoId }),
]);
const repoQuery = z.object({ repo: repoId.optional() });
const requiredRepoQuery = z.object({ repo: repoId });
const revision = z.string().min(1).max(200);
const createBody = z.strictObject({ scope: scopeSchema, document: z.unknown() });
const updateBody = z.strictObject({ revision, document: z.unknown() });
const deleteBody = z.strictObject({ revision });
const validateBody = z.strictObject({ document: z.unknown() });
const testBody = z.strictObject({ document: z.unknown(), text: z.string().max(64 * 1024) });
const checkBody = z
  .array(z.strictObject({ id: profileId, scope: scopeSchema }))
  .min(1)
  .max(200);

export type ProblemView = ProfileProblem;
const isError = (problem: ProblemView) => problem.severity !== 'warning';

function detectSecret(text: string): string | undefined {
  for (const detector of secretDetectors) {
    const flags = detector.pattern.flags.includes('g')
      ? detector.pattern.flags
      : `${detector.pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(detector.pattern.source, flags))) {
      const value = match.groups?.secret ?? match[0];
      if (!detector.entropy || entropy(value) >= detector.entropy) return detector.name;
    }
  }
  return undefined;
}
/** Messages can quote a pattern or an id, so a secret must never travel back inside one. */
function scrub(message: string) {
  let result = message;
  for (const detector of secretDetectors) {
    const flags = detector.pattern.flags.includes('g')
      ? detector.pattern.flags
      : `${detector.pattern.flags}g`;
    result = result.replace(new RegExp(detector.pattern.source, flags), '[secret]');
  }
  return result;
}

const secretRuleKeys = new Set(['id', 'type', 'detector', 'enabled', 'scope']);
/** Refuses values, never echoes them: the document names where, not what. */
function secretProblems(document: unknown): ProblemView[] {
  const problems: ProblemView[] = [];
  function walk(value: unknown, path: string[]) {
    if (typeof value === 'string') {
      const found = detectSecret(value);
      if (found)
        problems.push({
          path: path.join('.'),
          message: `Looks like a real secret (${found}). Secret values are refused here.`,
          severity: 'secret',
        });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const isSecretRule = path[0] === 'rules' && path.length === 2 && record.type === 'secret';
    for (const [key, item] of Object.entries(record)) {
      if (isSecretRule && !secretRuleKeys.has(key)) {
        problems.push({
          path: [...path, key].join('.'),
          message: `Secret rules name a detector and hold no value. Remove "${/^[\w$-]{1,40}$/.test(key) ? key : 'this field'}".`,
          severity: 'secret',
        });
        continue;
      }
      walk(key, [...path, key]);
      walk(item, [...path, key]);
    }
  }
  walk(document, []);
  return problems;
}

/** A pattern with one possible match can use a constant replacement and still restore. */
function isFixedPattern(pattern: string) {
  const body = pattern.replace(/^\(\?<!\[A-Za-z0-9_\]\)/, '').replace(/\(\?!\[A-Za-z0-9_\]\)$/, '');
  return !/[.*+?^$()[\]{}|]/.test(body.replace(/\\[^\w\s]/g, '')) && !/\\\w/.test(body);
}
function regexProblems(rule: Extract<Rule, { type: 'regex' }>): string | undefined {
  if (!rule.replace) return 'Regex replacement cannot be empty: it could never be restored.';
  if (/\$[`']/.test(rule.replace))
    return 'Regex replacement cannot copy the text around the match.';
  const refers = /\$(?:&|[1-9]|<[^>]+>)/.test(rule.replace);
  if (!refers && !isFixedPattern(rule.match))
    return 'Regex replacement must be reversible: reference the match with $1 or $<name>, so different originals stay different.';
  return undefined;
}

function pathOf(path: readonly PropertyKey[]) {
  return path.map(String).join('.');
}
/** Every hard problem in a document, located by path. The browser turns paths into lines. */
export function documentProblems(document: unknown): ProblemView[] {
  const secrets = secretProblems(document);
  const shape = documentSchema.profile.safeParse(document);
  if (!shape.success)
    return [
      ...secrets,
      ...shape.error.issues.map((issue) => ({
        path: pathOf(issue.path),
        message: scrub(issue.message),
      })),
    ];
  const problems: ProblemView[] = [...secrets];
  shape.data.rules.forEach((rule, index) => {
    const path = `rules.${index}`;
    try {
      validateRule(rule, rule.id);
    } catch (error) {
      problems.push({ path, message: scrub(error instanceof Error ? error.message : 'Bad rule') });
    }
    if (rule.type === 'regex') {
      const message = regexProblems(rule);
      if (message) problems.push({ path: `${path}.replace`, message });
    }
  });
  if (!problems.some(isError)) {
    try {
      validateProfile(document);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid profile';
      const index = shape.data.rules.findIndex((rule) => message.includes(`/${rule.id}`));
      problems.push({
        path: index >= 0 ? `rules.${index}` : '',
        message: scrub(message.replace(/^profile: /, '')),
      });
    }
  }
  return problems;
}

function overlapWarnings(document: unknown, others: SavedProfile[]): ProblemView[] {
  const parsed = documentSchema.profile.safeParse(document);
  if (!parsed.success) return [];
  const problems: ProblemView[] = [];
  parsed.data.rules.forEach((rule, index) => {
    if (rule.type !== 'literal') return;
    const mine = rule.match.toLowerCase();
    for (const other of others) {
      if (other.profile.name === parsed.data.name) continue;
      const hit = other.profile.rules.find((candidate) => {
        if (candidate.type !== 'literal') return false;
        const theirs = candidate.match.toLowerCase();
        return theirs.includes(mine) || mine.includes(theirs);
      });
      if (!hit || hit.type !== 'literal') continue;
      problems.push({
        path: `rules.${index}.match`,
        severity: 'warning',
        message:
          hit.match.toLowerCase() === mine
            ? `“${rule.match}” is also in ${other.profile.name}. Using both needs the same replacement.`
            : `“${rule.match}” overlaps “${hit.match}” in ${other.profile.name}. Longest match wins.`,
      });
    }
  });
  try {
    const warnings = ruleWarnings(parsed.data.rules);
    for (const warning of warnings) {
      const index = parsed.data.rules.findIndex((rule) => rule.id === warning.ruleId);
      problems.push({ path: `rules.${index}`, severity: 'warning', message: warning.message });
    }
  } catch {
    // ruleWarnings only reads rules that validated; a failure here is reported as an error above.
  }
  return problems;
}

function requireValid(document: unknown) {
  const errors = documentProblems(document).filter(isError);
  if (errors.length)
    throw new RequestError(
      400,
      errors.map((problem) => problem.message).join(' ') || 'Invalid profile',
    );
}

/* ---------- Scanning the registered source for hits and suggestions ---------- */
const skipped = compilePatterns([
  'node_modules/',
  'dist/',
  'build/',
  'vendor/',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.min.js',
  '*.map',
]);
const scanLimits = { files: 3000, fileBytes: 256 * 1024, totalBytes: 24 * 1024 * 1024 };

/** Regular text files only. A tracked symlink could otherwise read outside the repository. */
async function* scanFiles(root: string, excluded: (path: string) => boolean) {
  const listing = await runGitBytes(root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  let files = 0;
  let total = 0;
  for (const path of listing.toString('utf8').split('\0')) {
    if (!path || skipped(path) || excluded(path)) continue;
    if (files >= scanLimits.files || total >= scanLimits.totalBytes) return;
    const full = join(root, path);
    const info = await lstat(full).catch(() => undefined);
    if (!info?.isFile() || info.size > scanLimits.fileBytes) continue;
    const bytes = await readFile(full).catch(() => undefined);
    if (!bytes || bytes.includes(0)) continue;
    files += 1;
    total += bytes.length;
    yield bytes.toString('utf8');
  }
}

type Cached<T> = { at: number; value: T };
const scanCache = new Map<string, Cached<unknown>>();
async function cachedScan<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const found = scanCache.get(key);
  if (found && Date.now() - found.at < 60_000) return found.value as T;
  const value = await compute();
  if (scanCache.size >= 32) scanCache.clear();
  scanCache.set(key, { at: Date.now(), value });
  return value;
}
async function headOf(root: string) {
  return (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
}
async function repoPath(dashboard: Dashboard, id: string) {
  const repo = (await dashboard.overview()).find((item) => item.id === id);
  return repo && !repo.missing ? repo.path : undefined;
}

async function excludedBy(dashboard: Dashboard, id: string, profiles: SavedProfile[]) {
  const [security, repo] = await Promise.all([
    dashboard.settings.effective(),
    dashboard.sync.exclusions(id),
  ]);
  return compilePatterns([
    ...security.lockedExclusions,
    ...repo.patterns,
    ...profiles.flatMap((saved) => saved.profile.exclude ?? []),
  ]);
}

/** Replacements per rule id across the repo's text files, as a pull would apply them. */
async function countHits(dashboard: Dashboard, saved: SavedProfile, id: string) {
  const root = await repoPath(dashboard, id);
  if (!root) return {};
  const key = `hits:${root}:${await headOf(root)}:${hashJson(saved.profile)}`;
  return cachedScan(key, async () => {
    const hits: Record<string, number> = {};
    const replacer = createReplacer(saved.profile.rules);
    for await (const text of scanFiles(root, await excludedBy(dashboard, id, [saved]))) {
      try {
        for (const match of replacer.anonymize(text).preview)
          if (match.status === 'replaced') hits[match.ruleId] = (hits[match.ruleId] ?? 0) + 1;
      } catch {
        // A pull would stop on this file and report it. Hits are only an estimate.
      }
    }
    return hits;
  });
}

const commonHosts = new Set([
  'github.com',
  'gitlab.com',
  'npmjs.com',
  'www.npmjs.com',
  'registry.npmjs.org',
  'example.com',
  'www.example.com',
  'schema.org',
  'www.w3.org',
  'w3.org',
  'nodejs.org',
  'stackoverflow.com',
  'google.com',
  'www.google.com',
  'microsoft.com',
  'docs.microsoft.com',
  'mozilla.org',
  'developer.mozilla.org',
  'opensource.org',
  'json-schema.org',
  'unpkg.com',
]);
const commonWords = new Set(
  'abstract action api app application array async auth base buffer build builder button cache card channel class client code column command component config connection console container content context control controller core create custom data database date debug default delete detail dialog document dom error event exception factory field file filter form format function get group handler header helper home http id image index info input invalid item json key layout link list load local log logger login main manager map menu message method mock model module name node number object option order output page panel param parent password path plugin post project promise property provider public query read record request resource response result role root route router rule run save schema screen script search select send server service session set settings source state status store string style system tab table task test text theme time token tool type update url user util value view web window work write'
    .split(' ')
    .map((word) => word),
);
const commonAcronyms = new Set(
  'API APIS CLI CPU CSS CSV DOM DTO EOF ESM FAQ GET GIF GPU GUI HEAD HTML HTTP HTTPS IDE JPEG JSON JWT LICENSE MIME MIT NOTE NPM OAUTH ORM PATCH PDF PNG POST PUT RAM README REST SDK SHA SQL SSH SSL SVG TCP TLS TODO FIXME TSX UDP UI URI URL USB UTC UTF UUID WARN XML YAML ZIP AND THE NOT FOR NULL TRUE FALSE'.split(
    ' ',
  ),
);

/** Names worth a rule: found by shape, ranked by hits, minus what rules already cover. */
export function collectSuggestions(
  texts: Iterable<string>,
  covered: readonly string[],
): ProfileSuggestion[] {
  const hosts = new Map<string, number>();
  const prefixes = new Map<string, { hits: number; tokens: Set<string> }>();
  const acronyms = new Map<string, number>();
  const add = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const text of texts) {
    for (const [host] of text.matchAll(
      /\b(?:[a-z0-9][a-z0-9-]*\.)+(?:com|net|org|io|internal|local|corp|lan|cloud)\b/g,
    ))
      if (!commonHosts.has(host)) add(hosts, host);
    for (const [host] of text.matchAll(/\b[a-z]{2,}-(?:prod|staging|dev|qa|uat)-[a-z0-9-]+\b/g))
      add(hosts, host);
    for (const [token, prefix = ''] of text.matchAll(/\b([A-Z][a-z]{2,})(?:[A-Z][a-z0-9]+)+\b/g)) {
      if (commonWords.has(prefix.toLowerCase())) continue;
      const entry = prefixes.get(prefix) ?? { hits: 0, tokens: new Set<string>() };
      entry.hits += 1;
      entry.tokens.add(token);
      prefixes.set(prefix, entry);
    }
    for (const [word] of text.matchAll(/\b[A-Z]{3,6}\b/g))
      if (!commonAcronyms.has(word)) add(acronyms, word);
  }
  const known = covered.map((name) => name.toLowerCase());
  const isCovered = (text: string) => {
    const lower = text.toLowerCase();
    return known.some((name) => lower.includes(name) || name.includes(lower));
  };
  const suggestions: ProfileSuggestion[] = [
    ...[...hosts].map(([text, hits]) => ({ text, reason: 'host', hits })),
    ...[...prefixes]
      .filter(([, entry]) => entry.tokens.size >= 2)
      .map(([text, entry]) => ({ text, reason: 'PascalCase prefix', hits: entry.hits })),
    ...[...acronyms]
      .filter(([, hits]) => hits >= 3)
      .map(([text, hits]) => ({ text, reason: 'business acronym', hits })),
  ];
  return suggestions
    .filter((item) => !isCovered(item.text) && !detectSecret(item.text))
    .sort((a, b) => b.hits - a.hits || a.text.localeCompare(b.text))
    .slice(0, 8);
}

/* ---------- Lookups ---------- */
async function visibleProfiles(dashboard: Dashboard, repo?: string): Promise<SavedProfile[]> {
  if (repo) return dashboard.profiles(repo);
  const repos = await dashboard.overview();
  const lists = await Promise.all(repos.map((item) => dashboard.profiles(item.id)));
  const byId = new Map(
    [...(await dashboard.profiles()), ...lists.flat()].map((saved) => [saved.id, saved]),
  );
  return [...byId.values()];
}
/** Update and delete name only the id, so the scope comes from where the profile lives. */
async function locate(dashboard: Dashboard, id: string, repo?: string) {
  const saved = (await visibleProfiles(dashboard, repo)).find((item) => item.id === id);
  if (!saved) throw new RequestError(404, 'Profile no longer exists');
  return saved;
}

function listItem(saved: SavedProfile): ProfileListItem {
  return {
    id: saved.id,
    name: saved.profile.name,
    scope: saved.scope,
    ruleCount: saved.profile.rules.length,
    exclusionCount: saved.profile.exclude?.length ?? 0,
  };
}

async function lockedExclusions(dashboard: Dashboard, repo?: string): Promise<LockedExclusion[]> {
  const security = await dashboard.settings.effective();
  const locked: LockedExclusion[] = security.lockedExclusions.map((pattern) => ({
    pattern,
    source: 'policy',
  }));
  if (!repo) return locked;
  const seen = new Set(security.lockedExclusions);
  for (const pattern of (await dashboard.sync.exclusions(repo)).patterns)
    if (!seen.has(pattern)) locked.push({ pattern, source: 'global' });
  return locked;
}

export type ProfileDetailView = ProfileDetail;
async function detail(
  dashboard: Dashboard,
  saved: SavedProfile,
  repo?: string,
): Promise<ProfileDetailView> {
  const target = repo ?? (saved.scope.kind === 'repo' ? saved.scope.repoId : undefined);
  const repos = await dashboard.overview();
  return {
    id: saved.id,
    scope: saved.scope,
    revision: hashJson(saved.profile),
    document: saved.profile,
    hits: target ? await countHits(dashboard, saved, target) : {},
    lockedExclusions: await lockedExclusions(dashboard, target),
    usedBy: repos
      .filter((item) => saved.scope.kind === 'global' || item.id === saved.scope.repoId)
      .flatMap((item) => item.workspaces)
      .filter((workspace) => workspace.lastProfiles.includes(saved.profile.name)).length,
  };
}

/** Compare-and-write must not interleave, or two tabs could both pass the revision check. */
let writes: Promise<unknown> = Promise.resolve();
function serial<T>(action: () => Promise<T>): Promise<T> {
  const next = writes.then(action, action);
  writes = next.catch(() => undefined);
  return next;
}
function requireRevision(saved: SavedProfile, supplied: string) {
  if (hashJson(saved.profile) !== supplied)
    throw new RequestError(409, 'This profile changed since you opened it. Reload to continue.');
}
async function recordSave(dashboard: Dashboard, verb: string, id: string) {
  // The id only: a profile's name is often the very thing being hidden.
  await dashboard.sync.audit.record({ op: 'settings', outcome: 'ok', detail: `${verb} ${id}` });
}

export const profilesRoutes: Route[] = [
  route('GET /api/v2/profiles', async ({ dashboard, query }) => {
    const { repo } = repoQuery.parse(Object.fromEntries(query));
    return { profiles: (await dashboard.profiles(repo)).map(listItem) };
  }),
  route('POST /api/v2/profiles', async ({ dashboard, body }) => {
    const input = createBody.parse(await body());
    requireValid(input.document);
    const saved = await serial(() =>
      dashboard.saveProfile({ scope: input.scope, profile: input.document }),
    );
    await recordSave(dashboard, 'Created profile', saved.id);
    return detail(dashboard, saved);
  }),
  // Declared ahead of :id, which would otherwise claim this path.
  route('GET /api/v2/profiles/suggestions', async ({ dashboard, query }) => {
    const { repo } = requiredRepoQuery.parse(Object.fromEntries(query));
    const profiles = await dashboard.profiles(repo);
    const root = await repoPath(dashboard, repo);
    if (!root) return { suggestions: [] };
    const covered = profiles.flatMap((saved) =>
      saved.profile.rules.flatMap((rule) =>
        rule.type === 'literal' ? [rule.match, rule.replace] : [],
      ),
    );
    const key = `suggest:${root}:${await headOf(root)}:${hashJson(covered)}`;
    const suggestions = await cachedScan(key, async () => {
      const texts: string[] = [];
      for await (const text of scanFiles(root, await excludedBy(dashboard, repo, [])))
        texts.push(text);
      return collectSuggestions(texts, covered);
    });
    return { suggestions };
  }),
  route('POST /api/v2/profiles/validate', async ({ dashboard, body }) => {
    const { document } = validateBody.parse(await body());
    const problems = documentProblems(document);
    if (problems.some(isError)) return { problems };
    return { problems: overlapWarnings(document, await visibleProfiles(dashboard)) };
  }),
  route('POST /api/v2/profiles/test', async ({ body }) => {
    const { document, text } = testBody.parse(await body());
    const errors = documentProblems(document).filter(isError);
    if (errors.length) return { cloaked: '', restored: '', roundTrips: false, problems: errors };
    const rules = (document as { rules: unknown[] }).rules.map((rule) => ruleSchema.parse(rule));
    try {
      const replacer = createReplacer(rules);
      const { text: cloaked, ledger } = replacer.anonymize(text);
      const restored = replacer.restore(cloaked, ledger).text;
      return { cloaked, restored, roundTrips: restored === text, problems: [] };
    } catch (error) {
      return {
        cloaked: '',
        restored: '',
        roundTrips: false,
        problems: [
          { path: '', message: scrub(error instanceof Error ? error.message : 'Test failed') },
        ],
      };
    }
  }),
  route('POST /api/v2/profiles/check', async ({ dashboard, body }) =>
    dashboard.checkProfiles(checkBody.parse(await body())),
  ),
  route('GET /api/v2/profiles/:id', async ({ dashboard, params, query }) => {
    const { repo } = repoQuery.parse(Object.fromEntries(query));
    const id = profileId.parse(params.id);
    const saved = await locate(dashboard, id, repo).catch(async (error: unknown) => {
      // A repo profile opened while launched from another repository is still reachable.
      if (repo && error instanceof RequestError && error.status === 404)
        return locate(dashboard, id);
      throw error;
    });
    return detail(dashboard, saved, repo);
  }),
  route('PUT /api/v2/profiles/:id', async ({ dashboard, params, body }) => {
    const id = profileId.parse(params.id);
    const input = updateBody.parse(await body());
    requireValid(input.document);
    const saved = await serial(async () => {
      const current = await locate(dashboard, id);
      requireRevision(current, input.revision);
      return dashboard.saveProfile({ id, scope: current.scope, profile: input.document });
    });
    await recordSave(dashboard, 'Saved profile', saved.id);
    return detail(dashboard, saved);
  }),
  route('DELETE /api/v2/profiles/:id', async ({ dashboard, params, body }) => {
    const id = profileId.parse(params.id);
    const input = deleteBody.parse(await body());
    const deleted = await serial(async () => {
      const current = await locate(dashboard, id);
      requireRevision(current, input.revision);
      return dashboard.deleteProfile({ id, scope: current.scope });
    });
    await recordSave(dashboard, 'Deleted profile', id);
    return deleted;
  }),
  route('GET /api/v2/schema/:kind', ({ params }) => {
    const kind = documentKinds.find((item) => item === params.kind);
    if (!kind) throw new RequestError(404, 'Unknown schema');
    return jsonSchema(kind);
  }),
];
