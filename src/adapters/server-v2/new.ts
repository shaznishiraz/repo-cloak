import { basename, join, resolve } from 'node:path';
import pLimit from 'p-limit';
import { z } from 'zod';
import type { Dashboard } from '../../application/dashboard.js';
import { firstRunPresets } from '../../core/exclusion-presets.js';
import { mergeProfiles } from '../../core/merge.js';
import type { PreviewMatch } from '../../core/ledger.js';
import { anonymizePaths, validateRelativePath } from '../../core/paths.js';
import { compilePatterns } from '../../core/patterns.js';
import { assertWithinRoots, expandProfiles, isAllowedPath } from '../../core/profile-graph.js';
import { createReplacer } from '../../core/replacer.js';
import type { Profile, Rule } from '../../core/rules.js';
import { documentSchema } from '../../core/schemas.js';
import type {
  CommitEntry,
  NewCloakReview,
  SetupState,
  TreeNode,
  UncommittedFile,
} from '../../web/api/contracts.js';
import { canonicalPath, filterPaths, readSourceFiles } from '../files.js';
import { absoluteFolder, browseFolders } from '../folders.js';
import { commitFiles, repoState, runGit } from '../git.js';
import { OperationError } from '../ui-operations.js';
import { route } from './router.js';
import type { Route } from './router.js';

const repoId = z.string().regex(/^[a-f0-9]{16}$/);
const absolutePath = z.string().min(1).max(4096);
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .transform((path, context) => {
    try {
      return validateRelativePath(path);
    } catch {
      context.addIssue({ code: 'custom', message: 'Unsafe path or filename' });
      return z.NEVER;
    }
  });
const whole = z
  .string()
  .regex(/^\d{1,6}$/)
  .transform(Number);
const placeQuery = z.object({ repo: repoId, worktree: absolutePath }).strict();
const changesQuery = placeQuery
  .extend({ offset: whole.optional(), search: z.string().trim().max(200).optional() })
  .strict();
const treeQuery = placeQuery.extend({ directory: relativePath.optional() }).strict();
const folderQuery = z.object({ path: absolutePath.optional(), offset: whole.optional() }).strict();
const repoQuery = z.object({ repo: repoId.optional() }).strict();
const profileRef = z
  .object({
    id: z.string().min(1).max(200),
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('global') }).strict(),
      z.object({ kind: z.literal('repo'), repoId }).strict(),
    ]),
  })
  .strict();
const selectionSchema = z
  .object({
    repoId,
    worktree: absolutePath,
    uncommitted: z.array(relativePath).max(20_000),
    commits: z.array(z.string().regex(/^[a-f0-9]{7,64}$/)).max(200),
    paths: z.array(relativePath).max(5000),
    profiles: z.array(profileRef).max(50),
  })
  .strict();
const createSchema = selectionSchema
  .extend({
    name: z.string().trim().min(1).max(80),
    destination: absolutePath,
    groupId: z.uuid().optional(),
    postCreateCommands: z.array(z.string().trim().min(1).max(4000)).max(10),
    ignoreLeftovers: z.boolean(),
  })
  .strict();
type Selection = z.infer<typeof selectionSchema>;

/**
 * "Never pull" presets live in one reserved global profile, because the engine only knows
 * profile and repository exclusions. It is added to every new cloak, whichever chips are on.
 */
const neverPullName = 'Never pull';
const presets = firstRunPresets;
const presetIds = presets.map((preset) => preset.id) as [string, ...string[]];
const setupSchema = z
  .object({
    workspacesRoot: absolutePath.optional(),
    presets: z.array(z.enum(presetIds)).max(presets.length).optional(),
  })
  .strict();

async function neverPullProfile(dashboard: Dashboard) {
  return (await dashboard.profiles()).find((saved) => isNeverPull(saved.profile));
}
function isNeverPull(profile: Profile) {
  return profile.name === neverPullName && Array.isArray(profile.extensions?.presets);
}

/** A path from the browser is only used once Git confirms it is this repository's worktree. */
async function requireWorktree(dashboard: Dashboard, id: string, path: string) {
  const canonical = await canonicalPath(path);
  const trees = await dashboard.sync.worktrees(id);
  const valid = await Promise.all(trees.map((tree) => canonicalPath(tree.path)));
  if (!valid.includes(canonical) || (await repoState(canonical)).repoId !== id)
    throw new OperationError('validation', 'Select a worktree belonging to this repository');
  return canonical;
}

/** Everything Git would list for this worktree, before any exclusion. Ignored files never appear. */
async function sourcePaths(root: string) {
  const listed = await runGit(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '--deduplicate',
    '-z',
  ]);
  const gone = new Set((await runGit(root, ['ls-files', '--deleted', '-z'])).split('\0'));
  return [
    ...new Set(listed.split('\0').filter((path) => path && !path.endsWith('/') && !gone.has(path))),
  ].sort();
}

/** Names the rule that holds each path back; `global` is the engine's built-in default list. */
function exclusionRules(paths: string[], profiles: Profile[], repoExcludes: string[]) {
  const kept = new Set(filterPaths(paths, profiles, repoExcludes));
  const named = [
    ...new Set([...profiles.flatMap((profile) => profile.exclude ?? []), ...repoExcludes]),
  ].map((pattern) => ({ pattern, matches: compilePatterns([pattern]) }));
  return (path: string): string | null =>
    kept.has(path)
      ? null
      : (named.find((rule) => rule.matches(path))?.pattern ??
        (isAllowedPath(path, profiles) ? 'global' : 'allowRoots'));
}

async function workingChanges(root: string): Promise<Omit<UncommittedFile, 'excluded'>[]> {
  const fields = (
    await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  ).split('\0');
  const files: Omit<UncommittedFile, 'excluded'>[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const moved = code.includes('R') || code.includes('C');
    if (moved) index++;
    const status = code.includes('R')
      ? 'R'
      : code === '??'
        ? '?'
        : code.includes('D')
          ? 'D'
          : code.includes('A') || code.includes('C')
            ? 'A'
            : 'M';
    files.push({ path: field.slice(3), status });
  }
  return files;
}

const pageSize = 20;
/** Search walks this many recent commits, so an old match needs a narrower history. */
const searchDepth = 20_000;
async function commitPage(root: string, offset: number, search: string) {
  if (!(await repoState(root)).commit) return { commits: [], nextOffset: null };
  const format = '--format=%H%x00%cI%x00%an%x00%s%x00';
  const fields = (
    await runGit(
      root,
      search
        ? ['log', `-${searchDepth}`, format]
        : ['log', `-${pageSize + 1}`, `--skip=${offset}`, format],
    )
  ).split('\0');
  const found: { sha: string; when: string; author: string; subject: string }[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4)
    found.push({
      sha: (fields[index] ?? '').trim(),
      when: fields[index + 1] ?? '',
      author: fields[index + 2] ?? '',
      subject: fields[index + 3] ?? '',
    });
  const needle = search.toLowerCase();
  const matches = search
    ? found.filter(
        (commit) =>
          commit.sha.startsWith(needle) ||
          commit.subject.toLowerCase().includes(needle) ||
          commit.author.toLowerCase().includes(needle),
      )
    : found;
  const start = search ? offset : 0;
  const page = matches.slice(start, start + pageSize);
  const limit = pLimit(8);
  const commits: CommitEntry[] = await Promise.all(
    page.map((commit) =>
      limit(async () => ({
        sha: commit.sha,
        subject: commit.subject,
        when: commit.when,
        files: new Set(await commitFiles(root, commit.sha)).size,
      })),
    ),
  );
  return {
    commits,
    nextOffset: start + pageSize < matches.length ? offset + pageSize : null,
  };
}

function treeLevel(
  paths: string[],
  directory: string | undefined,
  ruleOf: (path: string) => string | null,
): TreeNode[] {
  const prefix = directory ? `${directory}/` : '';
  const folders = new Map<string, { files: number; total: number; rule: string | null }>();
  const files: TreeNode[] = [];
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const rule = ruleOf(path);
    if (slash < 0) {
      files.push({ path, kind: 'file', files: rule ? 0 : 1, excludedBy: rule });
      continue;
    }
    const folder = prefix + rest.slice(0, slash);
    const entry = folders.get(folder) ?? { files: 0, total: 0, rule: null };
    entry.total++;
    if (rule) entry.rule ??= rule;
    else entry.files++;
    folders.set(folder, entry);
  }
  const nodes: TreeNode[] = [...folders].map(([path, entry]) => ({
    path,
    kind: 'folder',
    files: entry.files,
    // A folder is only locked when nothing in it can be pulled.
    excludedBy: entry.files === 0 ? entry.rule : null,
  }));
  return [...nodes.sort((a, b) => a.path.localeCompare(b.path)), ...files];
}

const commonWords = new Set(
  'api apis app apps web site service services server client core main test tests repo repository code data source sources src backend frontend mobile docs lib libs sdk tool tools project platform worktree'.split(
    ' ',
  ),
);
function nameTokens(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length >= 4 && !commonWords.has(word.toLowerCase()));
}
function capitalized(word: string) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
/** Organisation and repository from origin; never the host or any credentials. */
async function remoteNames(root: string) {
  const url = await runGit(root, ['remote', 'get-url', 'origin']).catch(() => '');
  return url
    .trim()
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .slice(-2);
}
async function repoNames(path: string) {
  return [basename(path), ...(await remoteNames(path))];
}
function suggestNames(names: string[]) {
  const suggestions = new Set<string>();
  for (const name of names) {
    const words = nameTokens(name).map(capitalized);
    for (const word of words) suggestions.add(word);
    if (words.length > 1) suggestions.add(words.join(''));
  }
  return [...suggestions].slice(0, 6);
}

/** Linear scan: minified files have very long "words", which a greedy regex backtracks over. */
function findNames(text: string, tokens: string[]) {
  const lower = text.toLowerCase();
  const names = new Set<string>();
  const isPart = (char: string | undefined) => !!char && /[\w.-]/.test(char);
  for (const token of tokens) {
    let at = lower.indexOf(token);
    while (at >= 0 && names.size < 20) {
      let start = at;
      let end = at + token.length;
      while (start > 0 && isPart(text[start - 1])) start--;
      while (end < text.length && isPart(text[end])) end++;
      names.add(text.slice(start, end).slice(0, 80));
      at = lower.indexOf(token, end);
    }
  }
  return [...names];
}
function ruleLabel(rule: Rule) {
  if (rule.type === 'literal') return { find: rule.match, replace: rule.replace };
  if (rule.type === 'regex') return { find: `/${rule.match}/`, replace: rule.replace };
  return { find: `secret: ${rule.detector}`, replace: 'REDACTED' };
}

async function selectedProfiles(dashboard: Dashboard, input: Selection) {
  const available = await dashboard.profiles(input.repoId);
  const selected = input.profiles.map((ref) => {
    if (ref.scope.kind === 'repo' && ref.scope.repoId !== input.repoId)
      throw new OperationError('validation', 'Profile belongs to another repository');
    const found = available.find(
      (saved) => saved.id === ref.id && saved.scope.kind === ref.scope.kind,
    );
    if (!found) throw new OperationError('validation', 'Profile no longer exists');
    return found;
  });
  const expanded = expandProfiles(selected, available);
  const neverPull = available.find(
    (saved) =>
      isNeverPull(saved.profile) &&
      !expanded.some((item) => item.id === saved.id && item.scope.kind === saved.scope.kind),
  );
  return { chosen: selected, all: neverPull ? [...expanded, neverPull] : expanded };
}

/** Resolves the three sources into one deduplicated list, keeping out what the rules hold back. */
async function resolveSelection(dashboard: Dashboard, input: Selection) {
  const root = await requireWorktree(dashboard, input.repoId, input.worktree);
  if ((await dashboard.settings.security()).policy.status === 'invalid')
    throw new OperationError('validation', 'Machine policy is invalid; fix it before pulling');
  const { chosen, all } = await selectedProfiles(dashboard, input);
  const { patterns } = await dashboard.sync.exclusions(input.repoId);
  const inventory = await sourcePaths(root);
  const known = new Set(inventory);
  const picked = input.paths.flatMap((path) =>
    known.has(path) ? [path] : inventory.filter((item) => item.startsWith(`${path}/`)),
  );
  const uncommitted = input.uncommitted.filter((path) => known.has(path));
  const fromCommits = (
    await Promise.all(input.commits.map((commit) => commitFiles(root, commit)))
  ).flat();
  const explicit = [...new Set([...picked, ...uncommitted])];
  const candidates = [...new Set([...explicit, ...fromCommits])].sort();
  const profiles = all.map((saved) => saved.profile);
  const ruleOf = exclusionRules(candidates, profiles, patterns);
  return {
    root,
    chosen,
    all,
    kept: candidates.filter((path) => !ruleOf(path)),
    files: explicit.filter((path) => !ruleOf(path)),
    heldBack: candidates.flatMap((path) => {
      const rule = ruleOf(path);
      return rule ? [{ path, rule }] : [];
    }),
  };
}

function shellWords(values: string[]) {
  return values
    .map((value) => (/^[\w./:@,=-]+$/.test(value) ? value : posixQuote(value)))
    .join(',');
}
function cliEquivalent(input: Selection, chosen: { profile: Profile }[], uncommitted: boolean) {
  return [
    'repo-cloak pull',
    ...(uncommitted ? ['--working'] : []),
    ...(input.commits.length
      ? [`--commits ${input.commits.map((commit) => commit.slice(0, 7)).join(',')}`]
      : []),
    ...(input.paths.length ? [`--paths ${shellWords(input.paths)}`] : []),
    ...(chosen.length ? [`-p ${shellWords(chosen.map((saved) => saved.profile.name))}`] : []),
  ].join(' ');
}

/** Dry run over the same engine pieces as a pull, so a review cannot promise what a pull refuses. */
async function reviewSelection(dashboard: Dashboard, input: Selection): Promise<NewCloakReview> {
  const selection = await resolveSelection(dashboard, input);
  const rules = mergeProfiles(selection.all);
  const replacer = createReplacer(rules);
  const { files } = await readSourceFiles(selection.root, selection.kept, 16);
  assertWithinRoots(files, selection.all);
  const present = files.filter((file) => file.bytes);
  const mapped = anonymizePaths(
    present.map((file) => file.path),
    replacer,
    [],
  );
  let ledger = mapped.ledger;
  const cloakedPath = new Map(mapped.paths.map((path) => [path.original, path.anonymized]));
  const matches: PreviewMatch[] = [...mapped.preview];
  const repository = (await dashboard.overview()).find((repo) => repo.id === input.repoId);
  const repoPath = repository?.path ?? selection.root;
  const tokens = [
    ...new Set((await repoNames(repoPath)).flatMap(nameTokens).map((word) => word.toLowerCase())),
  ].filter(
    (token) =>
      !rules.some(
        (rule) =>
          (rule.type === 'literal' || rule.type === 'regex') &&
          rule.replace.toLowerCase().includes(token),
      ),
  );
  const leftovers = new Map<string, { path: string; name: string }>();
  const leftover = (path: string, name: string) => {
    if (leftovers.size < 50) leftovers.set(`${path}\0${name}`, { path, name });
  };
  let lines = 0;
  for (const file of present) {
    const cloaked = cloakedPath.get(file.path) ?? file.path;
    for (const name of findNames(cloaked, tokens)) leftover(file.path, name);
    if (file.text === undefined) continue;
    lines += file.text.split('\n').length;
    const result = replacer.anonymize(file.text, { file: file.path, scope: 'content' }, ledger);
    ledger = result.ledger;
    matches.push(...result.preview);
    for (const name of findNames(result.text, tokens)) leftover(file.path, name);
    for (const match of result.preview) {
      if (match.status !== 'skipped' || match.reason !== 'boundary') continue;
      const rule = rules.find((item) => item.id === match.ruleId);
      if (rule?.type === 'literal' && rule.common) continue;
      const [name] = findNames(file.text.slice(Math.max(0, match.start - 80), match.end + 80), [
        match.original.toLowerCase(),
      ]);
      leftover(file.path, name ?? match.original);
    }
  }
  const hits = new Map<Rule, number>();
  for (const match of matches) {
    if (match.status !== 'replaced') continue;
    const sameId = rules.filter((rule) => rule.id === match.ruleId);
    const flat = match.original.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const rule =
      sameId.find(
        (item) =>
          item.type === 'literal' && item.match.replace(/[^a-z0-9]/gi, '').toLowerCase() === flat,
      ) ?? sameId[0];
    if (rule) hits.set(rule, (hits.get(rule) ?? 0) + 1);
  }
  // Renamed paths first: those are what the preview is there to show.
  const changed = [...mapped.paths].sort(
    (a, b) => Number(a.anonymized === a.original) - Number(b.anonymized === b.original),
  );
  return {
    files: present.length,
    lines,
    heldBack: selection.heldBack,
    replacements: [...hits]
      .map(([rule, count]) => ({ ...ruleLabel(rule), hits: count }))
      .sort((a, b) => b.hits - a.hits),
    // The first entry is always the repository folder: it is what the suggested name comes from.
    pathPreview: [
      { source: basename(repoPath), cloaked: cloakedFolder(basename(repoPath), rules) },
      ...changed.slice(0, 5).map((path) => ({ source: path.original, cloaked: path.anonymized })),
    ],
    leftovers: [...leftovers.values()],
    cli: cliEquivalent(input, selection.chosen, input.uncommitted.length > 0),
  };
}
/** Same fallback as the engine: a generic name beats leaking the real repository name. */
function cloakedFolder(name: string, rules: Rule[]) {
  try {
    const text = createReplacer(rules).anonymize(name, { file: name, scope: 'paths' }).text;
    return text !== name && !text.includes('/') ? text : 'workspace';
  } catch {
    return 'workspace';
  }
}

function posixQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
function shellQuote(value: string) {
  if (process.platform !== 'win32') return posixQuote(value);
  if (/["%!^]/.test(value))
    throw new OperationError('validation', 'This value cannot be used in a Windows command');
  return `"${value}"`;
}
/** Commands run through a shell and branch names can hold `$(...)`, so every value is quoted. */
export function expandPostCreateCommand(command: string, values: Record<string, string>) {
  return command.replace(/\{(dest|source|branch|name|group|sha)\}/g, (_match, name: string) =>
    shellQuote(values[name] ?? ''),
  );
}

async function createOperation(dashboard: Dashboard, value: unknown) {
  const input = createSchema.parse(value);
  const selection = await resolveSelection(dashboard, input);
  const destination = resolve(absoluteFolder(input.destination));
  if (input.name !== basename(destination))
    throw new OperationError('validation', 'The destination folder must end with the cloak name');
  const repository = (await dashboard.overview()).find((repo) => repo.id === input.repoId);
  const paths = await Promise.all(
    (repository?.workspaces ?? []).map(async (workspace) => ({
      id: workspace.id,
      path: await canonicalPath(workspace.path),
    })),
  );
  const canonical = await canonicalPath(destination);
  const existing = paths.find((workspace) => workspace.path === canonical);
  if (!selection.kept.length)
    throw new OperationError('validation', 'No selected files remain after exclusions');
  // An existing cloak as the destination is "Add to it": it keeps its own recorded profiles.
  if (existing)
    return dashboard.sync.preview({
      intent: 'refresh',
      repoId: input.repoId,
      workspaceId: existing.id,
      worktree: selection.root,
      files: selection.files,
      commits: input.commits,
    });
  if (!selection.chosen.length)
    throw new OperationError('validation', 'Select at least one profile');
  const review = await reviewSelection(dashboard, input);
  if (review.leftovers.length && !input.ignoreLeftovers)
    throw new OperationError(
      'conflict',
      `${review.leftovers.length} real names have no rule; add a rule or ignore them`,
    );
  const { workspacesRoot } = await dashboard.settings.read();
  if (workspacesRoot && destination !== resolve(join(workspacesRoot, input.name)))
    throw new OperationError('validation', 'The destination folder is fixed in Settings');
  const group = input.groupId
    ? (await dashboard.groups.list()).find((item) => item.id === input.groupId)
    : undefined;
  if (input.groupId && !group) throw new OperationError('validation', 'Group no longer exists');
  const state = await repoState(selection.root);
  const values = {
    dest: destination,
    source: selection.root,
    branch: state.branch ?? '',
    name: input.name,
    group: group?.name ?? '',
    sha: state.commit ?? '',
  };
  return dashboard.sync.preview({
    intent: 'create',
    repoId: input.repoId,
    worktree: selection.root,
    ...(workspacesRoot ? { name: input.name } : { destination }),
    profiles: selection.all.map((saved) => ({ id: saved.id, scope: saved.scope })),
    files: selection.files,
    commits: input.commits,
    postCreateCommands: input.postCreateCommands.map((command) =>
      expandPostCreateCommand(command, values),
    ),
  });
}

async function setupState(
  dashboard: Dashboard,
  port: number,
  repo: string | undefined,
): Promise<SetupState> {
  const { store } = await dashboard.shell.session(port);
  const saved = await dashboard.profiles(repo);
  const neverPull = saved.find((item) => isNeverPull(item.profile));
  const enabled = neverPull?.profile.extensions?.presets as string[] | undefined;
  const repository = repo
    ? (await dashboard.overview()).find((item) => item.id === repo)
    : undefined;
  return {
    key: { exists: store.sealed, storage: store.storage },
    workspacesRoot: (await dashboard.settings.read()).workspacesRoot || null,
    exclusionPresets: presets.map((preset) => ({
      ...preset,
      enabled: enabled?.includes(preset.id) ?? true,
    })),
    profileCount: saved.filter((item) => !isNeverPull(item.profile)).length,
    suggestedNames:
      repository && !repository.missing ? suggestNames(await repoNames(repository.path)) : [],
  };
}

async function savePresets(dashboard: Dashboard, enabled: string[]) {
  const existing = await neverPullProfile(dashboard);
  const profile = documentSchema.profile.parse({
    kind: 'profile',
    schemaVersion: 1,
    name: neverPullName,
    description: 'Set during first run. Added to every new cloak.',
    rules: [],
    exclude: presets
      .filter((preset) => enabled.includes(preset.id))
      .flatMap((preset) => preset.patterns),
    extensions: { presets: enabled },
  });
  await dashboard.saveProfile({
    scope: { kind: 'global' },
    profile,
    ...(existing ? { id: existing.id } : {}),
  });
  await dashboard.sync.audit.record({
    op: 'settings',
    outcome: 'ok',
    detail: `Changed never-pull presets (${enabled.length} on)`,
  });
}

export const newRoutes: Route[] = [
  route('GET /api/v2/new/context', async ({ dashboard, query }) => {
    const { repo, worktree } = placeQuery.parse(Object.fromEntries(query));
    const root = await requireWorktree(dashboard, repo, worktree);
    const state = await repoState(root);
    const repository = (await dashboard.overview()).find((item) => item.id === repo);
    const base = (await dashboard.sync.worktrees(repo))[0]?.branch;
    const ahead =
      base && base !== state.branch
        ? await runGit(root, ['rev-list', '--count', '--end-of-options', `${base}..HEAD`])
            .then((count) => Number(count.trim()) || 0)
            .catch(() => 0)
        : 0;
    const existing = await Promise.all(
      (repository?.workspaces ?? []).map(async (workspace) => ({
        ...workspace,
        origin: workspace.worktree ? await canonicalPath(workspace.worktree) : null,
      })),
    );
    const { workspacesRoot } = await dashboard.settings.read();
    return {
      repoId: repo,
      worktree: root,
      branch: state.branch,
      ahead,
      existing: existing
        .filter((workspace) => workspace.origin === root && !workspace.missing)
        .map((workspace) => ({
          repoId: repo,
          workspaceId: workspace.id,
          name: workspace.name,
          path: workspace.path,
        })),
      destinationRoot: workspacesRoot || null,
      destinationLocked: !!workspacesRoot,
      groups: (await dashboard.groups.list()).map((group) => ({
        id: group.id,
        name: group.name,
        workspaceCount: group.members.length,
      })),
    };
  }),
  route('GET /api/v2/new/changes', async ({ dashboard, query }) => {
    const input = changesQuery.parse(Object.fromEntries(query));
    const root = await requireWorktree(dashboard, input.repo, input.worktree);
    const { patterns } = await dashboard.sync.exclusions(input.repo);
    const changes = await workingChanges(root);
    const ruleOf = exclusionRules(
      changes.map((file) => file.path),
      [],
      patterns,
    );
    return {
      uncommitted: changes.map((file) => ({ ...file, excluded: !!ruleOf(file.path) })),
      ...(await commitPage(root, input.offset ?? 0, input.search ?? '')),
    };
  }),
  route('GET /api/v2/new/tree', async ({ dashboard, query }) => {
    const input = treeQuery.parse(Object.fromEntries(query));
    const root = await requireWorktree(dashboard, input.repo, input.worktree);
    const { patterns } = await dashboard.sync.exclusions(input.repo);
    const neverPull = await neverPullProfile(dashboard);
    const paths = await sourcePaths(root);
    const ruleOf = exclusionRules(paths, neverPull ? [neverPull.profile] : [], patterns);
    return { nodes: treeLevel(paths, input.directory, ruleOf) };
  }),
  route('POST /api/v2/new/review', async ({ dashboard, body }) =>
    reviewSelection(dashboard, selectionSchema.parse(await body())),
  ),
  route('POST /api/v2/new/create', async ({ dashboard, body }) => {
    const { operationId, expiresAt, ...summary } = await createOperation(dashboard, await body());
    return { operationId, expiresAt, summary };
  }),
  route('GET /api/v2/worktrees/:repoId', async ({ dashboard, params }) => ({
    worktrees: await dashboard.sync.worktrees(repoId.parse(params.repoId)),
  })),
  route('GET /api/v2/folders', async ({ query }) => {
    const input = folderQuery.parse(Object.fromEntries(query));
    const { path, folders, next } = await browseFolders(input.path, input.offset ?? 0);
    return { path, folders, next };
  }),
  route('GET /api/v2/setup', async ({ dashboard, port, query }) => {
    const { repo } = repoQuery.parse(Object.fromEntries(query));
    return setupState(dashboard, port, repo);
  }),
  route('PUT /api/v2/setup', async ({ dashboard, port, body }) => {
    const input = setupSchema.parse(await body());
    if (input.workspacesRoot)
      await dashboard.settings.save({ workspacesRoot: input.workspacesRoot });
    // Saving seals a document, which is also what creates the key on a brand new store.
    if (input.presets) await savePresets(dashboard, input.presets);
    return setupState(dashboard, port, undefined);
  }),
];
