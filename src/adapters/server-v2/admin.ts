import { generateKeyPairSync, sign } from 'node:crypto';
import { z } from 'zod';
import type { Dashboard } from '../../application/dashboard.js';
import { auditOps } from '../../core/audit.js';
import type { AuditEvent } from '../../core/audit.js';
import { MAX_AGENT_FILE_BYTES } from '../../core/agent-requests.js';
import { createReplacer } from '../../core/replacer.js';
import type {
  AgentAccess,
  AgentRequest,
  AgentRequestDetail,
  AgentRequestState,
  AuditEventView,
  AuditOp,
  AuditPage,
  DashboardSettings,
  GuardCheck,
  KnownRepo,
  KnownWorktree,
  RepoDetail,
} from '../../web/api/contracts.js';
import { readLimitedSourceFiles } from '../agent-files.js';
import { runGit } from '../git.js';
import { RequestError, route } from './router.js';
import type { Route, RouteContext } from './router.js';

const repoId = z.string().regex(/^[a-f0-9]{16}$/);
const workspaceId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const folderPath = z.string().min(1).max(4096);

/* ---------- Known repos ---------- */

type LegacyRepo = Awaited<ReturnType<Dashboard['overview']>>[number];

async function knownRepo(dashboard: Dashboard, repo: LegacyRepo): Promise<KnownRepo> {
  const trees = repo.missing ? [] : await dashboard.sync.worktrees(repo.id).catch(() => []);
  return {
    id: repo.id,
    name: repo.name,
    path: repo.path,
    missing: repo.missing,
    workspaceCount: repo.workspaces.length,
    pinned: repo.pinned,
    worktreeCount: trees.length,
    lastUsedAt: repo.workspaces[0]?.lastUsedAt ?? null,
  };
}
async function requireRepo(dashboard: Dashboard, value: string | undefined) {
  const id = repoId.parse(value);
  const repo = (await dashboard.overview()).find((item) => item.id === id);
  if (!repo) throw new RequestError(404, 'Repository is not registered');
  return repo;
}

/** Ahead and behind its upstream, or the main checkout's branch when it has no upstream. */
async function aheadBehind(path: string, base: string | null) {
  for (const candidate of ['@{upstream}', base]) {
    if (!candidate) continue;
    try {
      const counts = await runGit(path, [
        'rev-list',
        '--left-right',
        '--count',
        `${candidate}...HEAD`,
        '--',
      ]);
      const [behind = '0', ahead = '0'] = counts.trim().split(/\s+/);
      return { ahead: Number(ahead), behind: Number(behind) };
    } catch {
      // No upstream, or no commits yet: try the next base.
    }
  }
  return { ahead: 0, behind: 0 };
}
async function knownWorktrees(dashboard: Dashboard, repo: LegacyRepo): Promise<KnownWorktree[]> {
  if (repo.missing) return [];
  const trees = await dashboard.sync.worktrees(repo.id).catch(() => []);
  const base = trees[0]?.branch ?? null;
  return Promise.all(
    trees.map(async (tree, index) => {
      const workspace = repo.workspaces.find((item) => item.worktree === tree.path);
      return {
        path: tree.path,
        isMain: index === 0,
        branch: tree.branch,
        ...(await aheadBehind(tree.path, index === 0 ? null : base)),
        workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
      };
    }),
  );
}
const exposureOps = new Set<string>(['create', 'pull', 'agent-approve']);
/** Paths the audit log shows leaving, or what the workspaces hold now if that is more. */
async function exposure(dashboard: Dashboard, repo: LegacyRepo) {
  const counts = await Promise.all(
    repo.workspaces.map((workspace) =>
      dashboard.sync
        .workspaceTarget(repo.id, workspace.id)
        .then(({ snapshot }) => Object.keys(snapshot.plain.files).length)
        .catch(() => 0),
    ),
  );
  const { events } = await dashboard.sync.audit.list({ limit: Number.MAX_SAFE_INTEGER });
  const seen = new Set<string>();
  for (const event of events)
    if (event.workspace?.repoId === repo.id && event.outcome === 'ok' && exposureOps.has(event.op))
      for (const file of event.files) seen.add(`${event.workspace.id}\0${file.path}`);
  return {
    filesOut: Math.max(
      seen.size,
      counts.reduce((sum, count) => sum + count, 0),
    ),
    workspaces: repo.workspaces.length,
  };
}
async function repoDetail(dashboard: Dashboard, repo: LegacyRepo): Promise<RepoDetail> {
  const [known, worktrees, rules, out] = await Promise.all([
    knownRepo(dashboard, repo),
    knownWorktrees(dashboard, repo),
    dashboard.sync.exclusions(repo.id),
    exposure(dashboard, repo),
  ]);
  return {
    repo: known,
    worktrees,
    rules: {
      defaultProfiles: repo.workspaces[0]?.lastProfiles ?? [],
      exclude: rules.patterns,
      allowedRoots: [],
    },
    exposure: out,
  };
}
const repoUpdate = z.strictObject({
  pinned: z.boolean().optional(),
  rules: z
    .strictObject({
      defaultProfiles: z.array(z.string().max(200)).max(50),
      exclude: z.array(z.string().max(500)).max(200),
      allowedRoots: z.array(z.string().max(4096)).max(50),
    })
    .optional(),
});

/* ---------- Agent requests ---------- */

const decisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('approve'), mode: z.enum(['full', 'signatures']) }),
  z.strictObject({ decision: z.literal('deny') }),
  z.strictObject({ decision: z.literal('auto-approve'), pattern: z.string().min(1).max(500) }),
]);
const requestKey = z
  .string()
  .max(1100)
  .transform((value, context) => {
    const parsed = z.uuid().safeParse(value.slice(0, 36));
    if (!parsed.success || value[36] !== ':' || value.length < 38) {
      context.addIssue({ code: 'custom', message: 'Invalid request id' });
      return z.NEVER;
    }
    return { requestId: parsed.data, path: value.slice(37) };
  });
type RawFile = {
  path: string;
  original: string;
  size: number;
  state: 'pending' | 'rejected' | 'pulled' | 'failed';
  excluded: boolean;
};
function requestState(file: RawFile): AgentRequestState {
  if (file.state === 'pulled') return 'pulled';
  if (file.state === 'rejected') return 'denied';
  if (file.excluded) return 'blocked';
  return file.state === 'failed' ? 'failed' : 'waiting';
}
/** The engine queues several files per request; the inbox decides on one file at a time. */
function flatRequest(
  owner: { repoId: string; id: string; name: string },
  request: { id: string; reason: string; createdAt: string },
  file: RawFile,
): AgentRequest {
  return {
    id: `${request.id}:${file.path}`,
    repoId: owner.repoId,
    workspaceId: owner.id,
    workspaceName: owner.name,
    path: file.path,
    reason: request.reason,
    state: requestState(file),
    createdAt: request.createdAt,
  };
}
async function allRequests(dashboard: Dashboard): Promise<AgentRequest[]> {
  const repos = await dashboard.overview();
  const owners = repos.flatMap((repo) =>
    repo.workspaces.map(({ id, name }) => ({ repoId: repo.id, id, name })),
  );
  const lists = await Promise.all(
    owners.map(async (owner) => {
      // A missing or unreadable workspace must not take the inbox down with it.
      const info = await dashboard.agents.info(owner.repoId, owner.id).catch(() => undefined);
      return (info?.requests ?? []).flatMap((request) =>
        request.files.map((file) => flatRequest(owner, request, file)),
      );
    }),
  );
  return lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function findRequest(
  dashboard: Dashboard,
  workspace: string | undefined,
  key: string | undefined,
) {
  const id = workspaceId.parse(workspace);
  const { requestId, path } = requestKey.parse(key);
  for (const repo of await dashboard.overview()) {
    const entry = repo.workspaces.find((item) => item.id === id);
    if (!entry) continue;
    const owner = { repoId: repo.id, id, name: entry.name };
    const info = await dashboard.agents.info(repo.id, id);
    const request = info.requests.find((item) => item.id === requestId);
    const file = request?.files.find((item) => item.path === path);
    if (request && file)
      return { owner, request, file, worktree: 'worktree' in info ? info.worktree : undefined };
    break;
  }
  throw new RequestError(404, 'Request unavailable');
}
type Found = Awaited<ReturnType<typeof findRequest>>;

const previewLines = 40;
/** The same replacer and ledger a pull uses, so this is what the agent would receive. */
async function cloakedPreview(dashboard: Dashboard, found: Found): Promise<string | null> {
  if (!found.worktree) return null;
  const { snapshot } = await dashboard.sync.workspaceTarget(found.owner.repoId, found.owner.id);
  const { files } = await readLimitedSourceFiles(
    found.worktree,
    [found.file.original],
    MAX_AGENT_FILE_BYTES,
    1,
  );
  const text = files[0]?.text;
  if (text === undefined) return null;
  const cloaked = createReplacer(snapshot.data.rules).anonymize(
    text,
    { file: found.file.path, scope: 'content' },
    snapshot.data.ledger,
  ).text;
  const lines = cloaked.split('\n');
  return lines.length > previewLines
    ? `${lines.slice(0, previewLines).join('\n')}\n… ${lines.length - previewLines} more lines`
    : cloaked;
}
async function requestDetail(dashboard: Dashboard, found: Found): Promise<AgentRequestDetail> {
  const summary = flatRequest(found.owner, found.request, found.file);
  const base = { ...summary, checks: [] as GuardCheck[], preview: null };
  if (summary.state === 'pulled' || summary.state === 'denied') return base;
  if (summary.state === 'blocked')
    return {
      ...base,
      checks: [
        {
          id: 'exclusions',
          state: 'blocked',
          title: 'Matches an exclusion',
          detail: 'Excluded files cannot be pulled',
        },
      ],
    };
  const checks: GuardCheck[] = [
    { id: 'exclusions', state: 'ok', title: 'No exclusion matches' },
    { id: 'size', state: 'ok', title: 'Within the size limit', detail: `${found.file.size} bytes` },
  ];
  const { requestId } = requestKey.parse(summary.id);
  // Only the engine's own preview can say whether this pull would go through today.
  let operationId: string | undefined;
  try {
    const preview = await dashboard.agents.preview(found.owner.repoId, found.owner.id, requestId, {
      paths: [found.file.path],
    });
    operationId = preview.operationId;
    checks.push(
      { id: 'recheck', state: 'ok', title: 'Source, exclusions and profiles re-checked' },
      {
        id: 'names',
        state: 'ok',
        title: 'Names replaced by your rules',
        detail: `${preview.replacements} replacements`,
      },
      preview.redactions
        ? {
            id: 'secrets',
            state: 'warning',
            title: 'Secret values will be redacted',
            detail: `${preview.redactions} found`,
          }
        : { id: 'secrets', state: 'ok', title: 'No secret rule matched' },
      ...preview.warnings.map((warning, index) => ({
        id: `warning-${index}`,
        state: 'warning' as const,
        title: warning,
      })),
    );
  } catch (error) {
    checks.push({
      id: 'recheck',
      state: 'blocked',
      title: 'This file cannot be pulled right now',
      detail: error instanceof Error ? error.message : 'Request check failed',
    });
    return { ...base, checks };
  } finally {
    if (operationId) dashboard.sync.cancel(operationId);
  }
  try {
    return { ...base, checks, preview: await cloakedPreview(dashboard, found) };
  } catch (error) {
    checks.push({
      id: 'preview',
      state: 'blocked',
      title: 'Could not cloak this file',
      detail: error instanceof Error ? error.message : 'Preview failed',
    });
    return { ...base, checks };
  }
}
async function approve(dashboard: Dashboard, found: Found) {
  const { repoId: repo, id } = found.owner;
  const preview = await dashboard.agents.preview(repo, id, found.request.id, {
    paths: [found.file.path],
  });
  try {
    await dashboard.agents.apply(repo, id, preview.operationId);
  } catch (error) {
    dashboard.sync.cancel(preview.operationId);
    throw error;
  }
  const done = await dashboard.sync.wait(preview.operationId);
  if (done.state !== 'completed') throw new RequestError(409, done.error ?? 'The pull failed');
}

/* ---------- Audit ---------- */

const aliases: Record<string, AuditOp[]> = {
  approve: ['agent-approve'],
  deny: ['agent-deny'],
  request: ['agent-approve', 'agent-deny'],
  key: ['key-rotate', 'key-migrate'],
};
export type AuditFilter = {
  ops?: AuditOp[];
  workspace?: string;
  who?: string;
  file?: string;
  since?: number;
  words: string[];
};
const units: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function parseSince(value: string, now: number) {
  const relative = /^(\d{1,5})([hdw])$/.exec(value);
  if (relative) return now - Number(relative[1]) * (units[relative[2] ?? ''] ?? 0);
  const at = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at))
    throw new RequestError(400, `since: use 7d, 12h, 2w or a date, not ${value}`);
  return at;
}
/** `op:push ws:acme who:sam file:src/a.ts since:7d` and free words, all of which must match. */
export function parseAuditQuery(query: string, now = Date.now()): AuditFilter {
  const filter: AuditFilter = { words: [] };
  for (const token of query.split(/\s+/).filter(Boolean)) {
    const colon = token.indexOf(':');
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : '';
    const value = token.slice(colon + 1);
    if (key === 'op') {
      const op = value.toLowerCase();
      const ops = aliases[op] ?? auditOps.filter((item) => item === op);
      if (!ops.length)
        throw new RequestError(400, `op: use one of ${auditOps.join(', ')}, not ${value}`);
      filter.ops = ops;
    } else if (key === 'ws') filter.workspace = value.toLowerCase();
    else if (key === 'who') filter.who = value.toLowerCase();
    else if (key === 'file') filter.file = value.toLowerCase();
    else if (key === 'since') filter.since = parseSince(value, now);
    else filter.words.push(token.toLowerCase());
  }
  return filter;
}
export function matchesAudit(event: AuditEventView, filter: AuditFilter) {
  const workspace = `${event.workspace?.name ?? ''} ${event.workspace?.id ?? ''}`.toLowerCase();
  const paths = event.files.map((file) => file.path.toLowerCase());
  if (filter.ops && !filter.ops.includes(event.op)) return false;
  if (filter.workspace && !workspace.includes(filter.workspace)) return false;
  if (filter.who && !event.who.toLowerCase().includes(filter.who)) return false;
  if (filter.file && !paths.some((path) => path.includes(filter.file ?? ''))) return false;
  if (filter.since !== undefined && Date.parse(event.at) < filter.since) return false;
  const text = [event.op, workspace, event.detail ?? '', event.who, ...paths]
    .join(' ')
    .toLowerCase();
  return filter.words.every((word) => text.includes(word));
}
function auditView(event: AuditEvent): AuditEventView {
  return {
    seq: event.seq,
    at: event.at,
    who: event.who,
    op: event.op,
    outcome: event.outcome,
    workspace: event.workspace,
    files: event.files,
    profiles: event.profiles,
    keyId: event.keyId,
    detail: event.detail,
    hash: event.hash,
    prevHash: event.prevHash,
  };
}
const auditQuery = z.strictObject({
  q: z.string().max(500).optional(),
  cursor: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .optional(),
});
async function auditPage(dashboard: Dashboard, query: URLSearchParams): Promise<AuditPage> {
  const input = auditQuery.parse(Object.fromEntries(query));
  const filter = parseAuditQuery(input.q ?? '');
  const limit = Number(input.limit ?? 100);
  const { events } = await dashboard.sync.audit.list({ limit: Number.MAX_SAFE_INTEGER });
  const matching = events.map(auditView).filter((event) => matchesAudit(event, filter));
  const cursor = input.cursor === undefined ? undefined : Number(input.cursor);
  const rest = cursor === undefined ? matching : matching.filter((event) => event.seq < cursor);
  const page = rest.slice(0, limit);
  return {
    events: page,
    total: matching.length,
    nextCursor: rest.length > limit ? (page.at(-1)?.seq ?? null) : null,
  };
}
/**
 * A push's file list holds real source names, which an export must not carry. Dropping them breaks
 * re-hashing that event, so the export says so; `hash` and `prevHash` still prove the chain's order.
 */
async function signedExport(dashboard: Dashboard) {
  const [{ events }, verification] = await Promise.all([
    dashboard.sync.audit.list({ limit: Number.MAX_SAFE_INTEGER }),
    dashboard.sync.audit.verify(),
  ]);
  const header = {
    kind: 'repo-cloak-audit-export',
    at: new Date().toISOString(),
    verification,
    redacted: 'File paths of push events are real source names and are omitted.',
  };
  const lines = [...events].reverse().map((event) =>
    event.op === 'push'
      ? {
          ...event,
          files: event.files.map(({ hash }) => ({ path: '[source path omitted]', hash })),
          redacted: true,
        }
      : event,
  );
  const jsonl = `${[header, ...lines].map((line) => JSON.stringify(line)).join('\n')}\n`;
  // A one-time key: the store cannot hold a signing key until the foundation adds one.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    jsonl,
    signature: sign(null, Buffer.from(jsonl), privateKey).toString('base64'),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/* ---------- Settings ---------- */

const settingsUpdate = z.strictObject({
  workspacesRoot: folderPath.optional(),
  postCreateCommands: z.array(z.string().trim().min(1).max(4000)).max(10).optional(),
  keyStorage: z.enum(['auto', 'keychain', 'file']).optional(),
  auditRetentionDays: z.number().int().positive().nullable().optional(),
  allowExclusionOverride: z.boolean().optional(),
  autoLockMinutes: z.number().int().positive().nullable().optional(),
});
async function readSettings(dashboard: Dashboard): Promise<DashboardSettings> {
  const [general, security] = await Promise.all([
    dashboard.settings.read(),
    dashboard.settings.security(),
  ]);
  return { ...general, security };
}
async function saveSettings(dashboard: Dashboard, value: unknown) {
  const input = settingsUpdate.parse(value);
  const { workspacesRoot, postCreateCommands, ...security } = input;
  // Everything that can refuse runs first, so a rejected save changes nothing.
  if (workspacesRoot) await dashboard.settings.validateRoot(workspacesRoot);
  if (Object.keys(security).length) await dashboard.settings.saveSecurity(security);
  if (workspacesRoot || postCreateCommands)
    await dashboard.settings.save({
      ...(workspacesRoot ? { workspacesRoot } : {}),
      ...(postCreateCommands ? { postCreateCommands } : {}),
    });
  return readSettings(dashboard);
}

async function agentAccess(context: RouteContext): Promise<AgentAccess> {
  const info = await context.dashboard.agents.info(
    repoId.parse(context.params.repoId),
    workspaceId.parse(context.params.workspaceId),
  );
  // Never the queued requests: their entries carry real file names.
  return {
    enabled: info.enabled,
    guidance: info.guidance,
    ...('worktree' in info ? { worktree: info.worktree } : {}),
  };
}

export const adminRoutes: Route[] = [
  route('GET /api/v2/repos', async ({ dashboard }) => {
    const repos = await dashboard.overview();
    return { repos: await Promise.all(repos.map((repo) => knownRepo(dashboard, repo))) };
  }),
  route('POST /api/v2/repos', async ({ dashboard, body }) => {
    const input = z.strictObject({ path: folderPath }).parse(await body());
    const added = await dashboard.addRepository(input);
    return knownRepo(dashboard, await requireRepo(dashboard, added.repoId));
  }),
  route('GET /api/v2/repos/:id', async ({ dashboard, params }) =>
    repoDetail(dashboard, await requireRepo(dashboard, params.id)),
  ),
  route('PUT /api/v2/repos/:id', async ({ dashboard, params, body }) => {
    const input = repoUpdate.parse(await body());
    const repo = await requireRepo(dashboard, params.id);
    if (input.rules) {
      // Saying "nothing else can be pulled" when nothing enforces it would be worse than refusing.
      if (input.rules.allowedRoots.length)
        throw new RequestError(501, 'Allowed roots are not enforced yet, so they cannot be saved');
      const current = repo.workspaces[0]?.lastProfiles ?? [];
      if (JSON.stringify(input.rules.defaultProfiles) !== JSON.stringify(current))
        throw new RequestError(501, 'Default profiles follow the last cloak and cannot be saved');
      await dashboard.sync.saveExclusions(repo.id, { patterns: input.rules.exclude });
    }
    if (input.pinned !== undefined) await dashboard.pinRepository(repo.id, input.pinned);
    return repoDetail(dashboard, await requireRepo(dashboard, repo.id));
  }),
  route('DELETE /api/v2/repos/:id', async ({ dashboard, params }) => {
    const id = repoId.parse(params.id);
    const result = await dashboard.removeRepository(id);
    await dashboard.pinRepository(id, false);
    return result;
  }),

  route('GET /api/v2/requests', async ({ dashboard }) => ({
    requests: await allRequests(dashboard),
  })),
  route('GET /api/v2/requests/:workspaceId/:id', async ({ dashboard, params }) =>
    requestDetail(dashboard, await findRequest(dashboard, params.workspaceId, params.id)),
  ),
  route('POST /api/v2/requests/:workspaceId/:id', async ({ dashboard, params, body }) => {
    const input = decisionSchema.parse(await body());
    const found = await findRequest(dashboard, params.workspaceId, params.id);
    // Fail closed: a request for less than the whole file must never send the whole file.
    if (input.decision === 'auto-approve')
      throw new RequestError(501, 'Auto-approve is not supported yet; nothing was approved');
    if (input.decision === 'approve' && input.mode === 'signatures')
      throw new RequestError(501, 'Signatures-only pulls are not supported yet; nothing was sent');
    if (input.decision === 'deny')
      await dashboard.agents.reject(found.owner.repoId, found.owner.id, found.request.id, {
        paths: [found.file.path],
      });
    else await approve(dashboard, found);
    return requestDetail(dashboard, await findRequest(dashboard, params.workspaceId, params.id));
  }),
  route('GET /api/v2/agents/:repoId/:workspaceId', agentAccess),
  route('PUT /api/v2/agents/:repoId/:workspaceId', async (context) => {
    const input = z
      .strictObject({ enabled: z.boolean(), rotate: z.boolean().optional() })
      .parse(await context.body());
    await context.dashboard.agents.configure(
      repoId.parse(context.params.repoId),
      workspaceId.parse(context.params.workspaceId),
      input,
    );
    return agentAccess(context);
  }),
  route('GET /api/v2/agents/:repoId/:workspaceId/mcp', ({ dashboard, params }) =>
    dashboard.agentClientConfig(repoId.parse(params.repoId), workspaceId.parse(params.workspaceId)),
  ),
  route(
    'POST /api/v2/agents/:repoId/:workspaceId/mcp/:provider',
    async ({ dashboard, params, body }) =>
      dashboard.installAgentClient(
        repoId.parse(params.repoId),
        workspaceId.parse(params.workspaceId),
        z.enum(['codex', 'claude']).parse(params.provider),
        z.strictObject({ confirm: z.literal(true) }).parse(await body()),
      ),
  ),

  route('GET /api/v2/audit', ({ dashboard, query }) => auditPage(dashboard, query)),
  route('POST /api/v2/audit/verify', ({ dashboard }) => dashboard.sync.audit.verify()),
  route('POST /api/v2/audit/export', ({ dashboard }) => signedExport(dashboard)),

  route('GET /api/v2/settings', ({ dashboard }) => readSettings(dashboard)),
  route('PUT /api/v2/settings', async ({ dashboard, body }) =>
    saveSettings(dashboard, await body()),
  ),
  route('POST /api/v2/settings/key/rotate', ({ dashboard }) => dashboard.security.rotateKey()),
  route('POST /api/v2/settings/key/migrate', async ({ dashboard, body }) => {
    const { target } = z.strictObject({ target: z.enum(['file', 'keychain']) }).parse(await body());
    return dashboard.security.migrateKey(target);
  }),
];
