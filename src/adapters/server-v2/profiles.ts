import { z } from 'zod';
import type { Dashboard } from '../../application/dashboard.js';
import { hashJson } from '../../core/hash.js';
import type { ProfileScope, SavedProfile } from '../../core/profiles.js';
import { createReplacer } from '../../core/replacer.js';
import { mergeProfiles } from '../../core/merge.js';
import { expandProfiles, extendsDirectly, rootProblem } from '../../core/profile-graph.js';
import { unsafeRegex, validateProfile, validateRule } from '../../core/rules.js';
import type { Rule } from '../../core/rules.js';
import { documentKinds, documentSchema, jsonSchema, ruleSchema } from '../../core/schemas.js';
import { secretDetectors } from '../../core/secrets.js';
import { ruleWarnings } from '../../core/variants.js';
import type {
  LockedExclusion,
  ProfileDetail,
  ProfileListItem,
  ProfileProblem,
} from '../../web/api/contracts.js';
import { contentPatterns, createRegexScan } from '../regex-worker.js';
import { countHits, detectSecret, scanSuggestions } from './profile-scan.js';
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
const placement = { scope: scopeSchema.optional(), id: profileId.optional() };
const validateBody = z.strictObject({ document: z.unknown(), ...placement });
const testBody = z.strictObject({
  document: z.unknown(),
  text: z.string().max(64 * 1024),
  ...placement,
});
const checkBody = z
  .array(z.strictObject({ id: profileId, scope: scopeSchema }))
  .min(1)
  .max(200);

export type ProblemView = ProfileProblem;
const isError = (problem: ProblemView) => problem.severity !== 'warning';

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
      const unsafe = unsafeRegex(rule);
      if (unsafe) problems.push({ path: `${path}.match`, message: `Refused: ${unsafe}.` });
    }
  });
  shape.data.allowRoots?.forEach((root, index) => {
    const message = rootProblem(root);
    if (message) problems.push({ path: `allowRoots.${index}`, message: scrub(message) });
  });
  if (shape.data.schemaVersion < 2)
    for (const key of ['extends', 'allowRoots'] as const)
      if (shape.data[key] !== undefined)
        problems.push({ path: key, message: `${key} needs "schemaVersion": 2.` });
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

type Placement = { scope?: ProfileScope | undefined; id?: string | undefined };

/** The document as a saved profile with its parents, resolved against what its scope can see. */
async function chainOfDocument(dashboard: Dashboard, document: unknown, place: Placement) {
  const scope = place.scope ?? { kind: 'global' };
  const known = await dashboard.profiles(scope.kind === 'repo' ? scope.repoId : undefined);
  const id = place.id ?? 'pf_unsaved';
  const draft: SavedProfile = { id, scope, profile: documentSchema.profile.parse(document) };
  const others = known.filter((saved) => !(saved.id === id && saved.scope.kind === scope.kind));
  return expandProfiles([draft], [...others, draft]);
}
/** Parent problems: missing, ambiguous, cycle, depth, or a conflict with what it inherits. */
async function graphProblems(
  dashboard: Dashboard,
  document: unknown,
  place: Placement,
): Promise<ProblemView[]> {
  try {
    mergeProfiles(await chainOfDocument(dashboard, document, place));
    return [];
  } catch (error) {
    if (error instanceof z.ZodError) return [];
    const message = error instanceof Error ? error.message : 'Invalid parents';
    return [{ path: 'extends', message: scrub(message) }];
  }
}
async function requireValid(dashboard: Dashboard, document: unknown, place: Placement) {
  const errors = documentProblems(document).filter(isError);
  if (!errors.length) errors.push(...(await graphProblems(dashboard, document, place)));
  if (errors.length)
    throw new RequestError(
      400,
      errors.map((problem) => problem.message).join(' ') || 'Invalid profile',
    );
}
/** Deleting or renaming a parent would break its children, so it names them instead. */
async function requireNoChildren(dashboard: Dashboard, saved: SavedProfile, verb: string) {
  const children = (await visibleProfiles(dashboard)).filter((other) =>
    extendsDirectly(other, saved),
  );
  if (children.length)
    throw new RequestError(
      409,
      `Cannot ${verb} ${saved.profile.name}: ${children.map((item) => item.profile.name).join(', ')} extend it.`,
    );
}
/** Why a saved profile cannot be used any more. It stays listed so it can be fixed. */
function savedProblem(saved: SavedProfile) {
  try {
    validateProfile(saved.profile);
    return undefined;
  } catch (error) {
    return scrub(error instanceof Error ? error.message : 'Invalid profile').replace(
      /^profile: /,
      '',
    );
  }
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
  const problem = savedProblem(saved);
  return {
    ...(problem ? { problem } : {}),
    ...(saved.profile.extends?.length ? { extends: saved.profile.extends } : {}),
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
  const scan = target ? await countHits(dashboard, saved, target) : { hits: {} };
  const hitsError = savedProblem(saved) ?? (scan.error && scrub(scan.error));
  return {
    id: saved.id,
    scope: saved.scope,
    revision: hashJson(saved.profile),
    document: saved.profile,
    hits: scan.hits,
    ...(hitsError ? { hitsError } : {}),
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
    await requireValid(dashboard, input.document, { scope: input.scope });
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
    const covered = profiles.flatMap((saved) =>
      saved.profile.rules.flatMap((rule) =>
        rule.type === 'literal' ? [rule.match, rule.replace] : [],
      ),
    );
    return { suggestions: await scanSuggestions(dashboard, repo, covered) };
  }),
  route('POST /api/v2/profiles/validate', async ({ dashboard, body }) => {
    const { document, ...place } = validateBody.parse(await body());
    const problems = documentProblems(document);
    if (problems.some(isError)) return { problems };
    const graph = await graphProblems(dashboard, document, place);
    if (graph.length) return { problems: graph };
    return { problems: overlapWarnings(document, await visibleProfiles(dashboard)) };
  }),
  route('POST /api/v2/profiles/test', async ({ dashboard, body }) => {
    const { document, text, ...place } = testBody.parse(await body());
    const errors = documentProblems(document).filter(isError);
    if (!errors.length) errors.push(...(await graphProblems(dashboard, document, place)));
    if (errors.length) return { cloaked: '', restored: '', roundTrips: false, problems: errors };
    const rules = (document as { extends?: unknown[] }).extends?.length
      ? mergeProfiles(await chainOfDocument(dashboard, document, place))
      : (document as { rules: unknown[] }).rules.map((rule) => ruleSchema.parse(rule));
    const patterns = contentPatterns(rules);
    const scan = patterns.length ? createRegexScan(patterns) : undefined;
    try {
      await scan?.prepare(text);
      const replacer = createReplacer(rules, scan?.engine);
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
    } finally {
      scan?.close();
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
    const saved = await serial(async () => {
      const current = await locate(dashboard, id);
      await requireValid(dashboard, input.document, { scope: current.scope, id });
      requireRevision(current, input.revision);
      const { name } = documentSchema.profile.parse(input.document);
      if (name !== current.profile.name) await requireNoChildren(dashboard, current, 'rename');
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
      await requireNoChildren(dashboard, current, 'delete');
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
