/**
 * Types shared by the local server and the browser. Types only: this file must stay free of
 * runtime code so it can be imported on both sides.
 */
export type UiKind = 'classic' | 'next';

export type KeyStorageKind = 'file' | 'keychain';
export type PolicyStatus = 'none' | 'active' | 'invalid';
export type SessionInfo = {
  app: 'repo-cloak';
  protocol: 1;
  version: string;
  ui: UiKind;
  port: number;
  store: {
    sealed: boolean;
    keyId: string | null;
    storage: KeyStorageKind | null;
    /** A plain key file exists and the OS keychain could hold it instead. */
    migrationAvailable: boolean;
    /** A rotation has not finished resealing yet; the retired key is still retained. */
    rotationPending: boolean;
  };
  policy: { status: PolicyStatus; locked: string[] };
  /** Audit events that could not be written since this server started. */
  auditFailures: number;
};

export type WorkspaceState = 'clean' | 'to-push' | 'source-moved' | 'missing' | 'unreadable';
export type WorkspaceCounts = {
  tracked: number;
  modified: number;
  added: number;
  deleted: number;
};
/** main repo -> worktree@sha -> cloak */
export type Lineage = {
  repo: { id: string; name: string; path: string };
  worktree: { path: string; branch: string | null; sha: string | null } | null;
  cloak: { id: string; name: string; path: string };
};
export type OverviewWorkspace = {
  id: string;
  repoId: string;
  name: string;
  path: string;
  groupId: string | null;
  state: WorkspaceState;
  counts: WorkspaceCounts;
  sourceMoved: boolean;
  lineage: Lineage;
  pendingRequests: number;
  lastUsedAt: string;
  lastPullAt: string | null;
};
export type OverviewRepo = {
  id: string;
  name: string;
  path: string;
  missing: boolean;
  workspaceCount: number;
};
export type OverviewGroup = { id: string; name: string; workspaceCount: number };
export type LaunchContext =
  | { kind: 'none' }
  | { kind: 'repo'; repoId: string; label: string; path: string; branch: string | null }
  | {
      kind: 'workspace';
      repoId: string;
      workspaceId: string;
      label: string;
      path: string;
      branch: string | null;
    }
  | { kind: 'group'; groupId: string; label: string; path: string | null; branch: null };
export type Overview = {
  launch: LaunchContext;
  repos: OverviewRepo[];
  groups: OverviewGroup[];
  workspaces: OverviewWorkspace[];
  pendingAgentRequests: number;
  profileCount: number;
  workspacesRoot: string | null;
};

/* ---------- Shared operation flow: preview, then apply, then poll ---------- */
export type OperationSummary = {
  intent: 'create' | 'refresh' | 'restore';
  source: { path: string; branch: string | null };
  destination: { path: string; branch: string | null };
  writes: string[];
  deletes: string[];
  warnings: string[];
  conflicts: string[];
  profileChanges: string[];
  replacements: number;
  canApply: boolean;
  forced: boolean;
  redactions: number;
  postCreateCommands: string[];
};
export type OperationPreview = {
  operationId: string;
  expiresAt: string;
  summary: OperationSummary;
};
export type OperationState = {
  operationId: string;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired';
  expiresAt: string;
  result?: OperationResult;
  error?: string;
  code?: string;
};
export type OperationResult = {
  status: string;
  workspace: string;
  workspaceId: string;
  writes: string[];
  deletes: string[];
  replacements: number;
  skipped: number;
  warnings: string[];
  profileChanges: string[];
};
export type ApplyRequest = { deletions?: boolean; profiles?: boolean; force?: boolean };

/* ---------- 10-home ---------- */
export type PushTarget =
  | { kind: 'origin' }
  | { kind: 'main' }
  | { kind: 'worktree'; path: string }
  | { kind: 'new-worktree'; branch: string }
  | { kind: 'patch' }
  | { kind: 'dry-run' };
export type PullTarget =
  | { kind: 'origin' }
  | { kind: 'main' }
  | { kind: 'worktree'; path: string }
  | { kind: 'commit'; ref: string };
export type PendingChange = {
  path: string;
  restoredPath: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
};
export type GuardCheck = {
  id: string;
  state: 'ok' | 'warning' | 'blocked' | 'info';
  title: string;
  detail?: string;
};
export type WorkspaceDetail = {
  workspace: OverviewWorkspace;
  lastPushAt: string | null;
  pending: PendingChange[];
  guards: GuardCheck[];
  requests: AgentRequest[];
  history: AuditEventView[];
};
export type GroupMember = {
  workspaceId: string;
  repoId: string;
  folder: string;
  source: string;
  target: PushTarget;
  toPush: number;
  sourceMoved: number;
  plan: string;
};
export type GroupDetail = {
  id: string;
  name: string;
  folder: string | null;
  revision: string;
  members: GroupMember[];
  rules: { stopOnGuardFailure: boolean; sameCommitMessage: boolean };
  runs: AuditEventView[];
};
export type GroupBulkRequest = {
  direction: 'pull' | 'push';
  revision: string;
  stopOnGuardFailure: boolean;
  commitMessage?: string;
};

/* ---------- 20-new-cloak ---------- */
export type ExistingCloak = { repoId: string; workspaceId: string; name: string; path: string };
export type NewCloakContext = {
  repoId: string;
  worktree: string;
  branch: string | null;
  ahead: number;
  existing: ExistingCloak[];
  destinationRoot: string | null;
  destinationLocked: boolean;
  groups: OverviewGroup[];
};
export type UncommittedFile = {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | '?';
  excluded: boolean;
};
export type CommitEntry = { sha: string; subject: string; when: string; files: number };
export type TreeNode = {
  path: string;
  kind: 'file' | 'folder';
  files: number;
  excludedBy: string | null;
};
export type NewCloakSelection = {
  repoId: string;
  worktree: string;
  uncommitted: string[];
  commits: string[];
  paths: string[];
  profiles: { id: string; scope: ProfileScopeRef }[];
};
export type NewCloakReview = {
  files: number;
  lines: number;
  heldBack: { path: string; rule: string }[];
  replacements: { find: string; replace: string; hits: number }[];
  pathPreview: { source: string; cloaked: string }[];
  leftovers: { path: string; name: string }[];
  cli: string;
};
export type NewCloakCreate = NewCloakSelection & {
  name: string;
  destination: string;
  groupId?: string;
  postCreateCommands: string[];
  ignoreLeftovers: boolean;
};
export type SetupState = {
  key: { exists: boolean; storage: KeyStorageKind | null };
  workspacesRoot: string | null;
  exclusionPresets: { id: string; name: string; patterns: string[]; enabled: boolean }[];
  profileCount: number;
  suggestedNames: string[];
};

/* ---------- 30-push ---------- */
export type PushFileFlag =
  'clean' | 'source-moved' | 'auto-merge' | 'conflict' | 'new-derived-name';
export type PushFile = {
  path: string;
  restoredPath: string;
  status: 'modified' | 'added' | 'deleted';
  additions: number;
  deletions: number;
  flags: PushFileFlag[];
};
export type DiffLine = {
  kind: 'context' | 'add' | 'remove';
  line: number;
  cloaked: string;
  restored: string;
};
export type PushReview = {
  target: PushTarget;
  files: PushFile[];
  checks: GuardCheck[];
  derivedNames: { cloaked: string; restored: string }[];
  operationId: string | null;
  canApply: boolean;
};
export type PushApply = {
  operationId: string;
  mode: 'write' | 'stage' | 'commit';
  commitMessage?: string;
  repull: boolean;
  includeGroupMembers: boolean;
  mergeMode: 'merge' | 'overwrite';
};
export type PushBackup = { id: string; createdAt: string; expiresAt: string; files: number };

/* ---------- 40-profiles ---------- */
export type ProfileScopeRef = { kind: 'global' } | { kind: 'repo'; repoId: string };
export type ProfileRuleKind = 'brand' | 'keyword' | 'term' | 'regex' | 'secret';
export type ProfileListItem = {
  id: string;
  name: string;
  scope: ProfileScopeRef;
  ruleCount: number;
  exclusionCount: number;
};
export type LockedExclusion = { pattern: string; source: 'policy' | 'global' };
export type ProfileDetail = {
  id: string;
  scope: ProfileScopeRef;
  revision: string;
  /** The stored document, validated by the server's profile schema. */
  document: unknown;
  hits: Record<string, number>;
  lockedExclusions: LockedExclusion[];
};
export type ProfileProblem = { line?: number; path: string; message: string };
export type ProfileTestResult = {
  cloaked: string;
  restored: string;
  roundTrips: boolean;
  problems: ProfileProblem[];
};
export type ProfileSuggestion = { text: string; reason: string; hits: number };

/* ---------- 50-admin ---------- */
export type KnownRepo = OverviewRepo & {
  pinned: boolean;
  worktreeCount: number;
  lastUsedAt: string | null;
};
export type KnownWorktree = {
  path: string;
  isMain: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  workspace: { id: string; name: string } | null;
};
export type RepoRules = { defaultProfiles: string[]; exclude: string[]; allowedRoots: string[] };
export type RepoDetail = {
  repo: KnownRepo;
  worktrees: KnownWorktree[];
  rules: RepoRules;
  exposure: { filesOut: number; workspaces: number };
};
export type AgentRequestState = 'waiting' | 'blocked' | 'approved' | 'denied' | 'pulled' | 'failed';
export type AgentRequest = {
  id: string;
  repoId: string;
  workspaceId: string;
  workspaceName: string;
  path: string;
  reason: string;
  state: AgentRequestState;
  createdAt: string;
};
export type AgentRequestDetail = AgentRequest & { checks: GuardCheck[]; preview: string | null };
export type AgentDecision =
  | { decision: 'approve'; mode: 'full' | 'signatures' }
  | { decision: 'deny' }
  | { decision: 'auto-approve'; pattern: string };

export type AuditOp =
  | 'create'
  | 'pull'
  | 'push'
  | 'delete'
  | 'agent-approve'
  | 'agent-deny'
  | 'settings'
  | 'key-rotate'
  | 'key-migrate'
  | 'audit-retention';
export type AuditFile = { path: string; hash?: string | undefined };
export type AuditEventView = {
  seq: number;
  at: string;
  who: string;
  op: AuditOp;
  outcome: 'ok' | 'failed';
  workspace?: { repoId?: string | undefined; id: string; name?: string | undefined } | undefined;
  files: AuditFile[];
  profiles: { id: string; hash: string }[];
  keyId: string | null;
  detail?: string | undefined;
  hash: string;
  prevHash: string;
};
export type AuditPage = { events: AuditEventView[]; total: number; nextCursor: number | null };
export type AuditVerification =
  | { ok: true; count: number; headHash: string | null }
  | {
      ok: false;
      count: number;
      firstBroken: { line: number; seq: number | null; reason: string };
    };

export type LockedSetting =
  'lockedExclusions' | 'auditRetentionDays' | 'allowExclusionOverride' | 'autoLockMinutes';
export type SecuritySettings = {
  keyStorage: 'auto' | KeyStorageKind;
  auditRetentionDays: number | null;
  allowExclusionOverride: boolean;
  autoLockMinutes: number | null;
  lockedExclusions: string[];
  locked: LockedSetting[];
  policy: {
    status: PolicyStatus;
    path: string | null;
    signed: boolean;
    message?: string | undefined;
  };
};
export type KeyRotationResult = {
  keyId: string;
  previousKeyId: string;
  resealed: number;
  pending: string[];
};
export type SupplyChainReport = {
  version: string;
  directDependencies: number;
  productionPackages: number;
  installScriptsAllowed: boolean;
  pinned: boolean;
  integrityHashes: boolean;
  bundledBrowserPackages: string[];
};
export type DashboardSettings = {
  workspacesRoot: string;
  postCreateCommands: string[];
  security: SecuritySettings;
};

/* ---------- Route map: `METHOD path` to its query, body and response ---------- */
type R<Response, Body = never, Query = never> = { response: Response; body: Body; query: Query };
export type V2Api = {
  // 00-foundation
  'GET /api/v2/session': R<SessionInfo>;
  'GET /api/v2/overview': R<Overview, never, LaunchQuery>;
  // Shared by every package that previews, applies or cancels an operation.
  'GET /api/v2/operations/:id': R<OperationState>;
  'POST /api/v2/operations/:id/apply': R<OperationState, ApplyRequest>;
  'DELETE /api/v2/operations/:id': R<OperationState>;
  // 10-home
  'GET /api/v2/workspaces/:repoId/:id': R<WorkspaceDetail>;
  'POST /api/v2/workspaces/:repoId/:id/pull': R<OperationPreview, { target: PullTarget }>;
  'POST /api/v2/workspaces/:repoId/:id/push': R<OperationPreview, { target: PushTarget }>;
  'GET /api/v2/groups/:id': R<GroupDetail>;
  'POST /api/v2/groups/:id/bulk': R<OperationPreview, GroupBulkRequest>;
  // 20-new-cloak
  'GET /api/v2/new/context': R<NewCloakContext, never, { repo: string; worktree: string }>;
  'GET /api/v2/new/changes': R<
    { uncommitted: UncommittedFile[]; commits: CommitEntry[]; nextOffset: number | null },
    never,
    { repo: string; worktree: string; offset?: string; search?: string }
  >;
  'GET /api/v2/new/tree': R<
    { nodes: TreeNode[] },
    never,
    { repo: string; worktree: string; directory?: string }
  >;
  'POST /api/v2/new/review': R<NewCloakReview, NewCloakSelection>;
  'POST /api/v2/new/create': R<OperationPreview, NewCloakCreate>;
  'GET /api/v2/setup': R<SetupState, never, { repo?: string }>;
  'PUT /api/v2/setup': R<SetupState, { workspacesRoot?: string; presets?: string[] }>;
  // 30-push
  'POST /api/v2/push/:repoId/:id/review': R<PushReview, { target: PushTarget }>;
  'GET /api/v2/push/:repoId/:id/diff': R<{ lines: DiffLine[] }, never, { path: string }>;
  'POST /api/v2/push/:repoId/:id/apply': R<OperationState, PushApply>;
  'GET /api/v2/push/:repoId/:id/backups': R<{ backups: PushBackup[] }>;
  'POST /api/v2/push/:repoId/:id/backups/:backupId/undo': R<{ restored: number }>;
  // 40-profiles
  'GET /api/v2/profiles': R<{ profiles: ProfileListItem[] }, never, { repo?: string }>;
  'POST /api/v2/profiles': R<ProfileDetail, { scope: ProfileScopeRef; document: unknown }>;
  'GET /api/v2/profiles/:id': R<ProfileDetail, never, { repo?: string }>;
  'PUT /api/v2/profiles/:id': R<ProfileDetail, { revision: string; document: unknown }>;
  'DELETE /api/v2/profiles/:id': R<{ deleted: string }, { revision: string }>;
  'POST /api/v2/profiles/validate': R<{ problems: ProfileProblem[] }, { document: unknown }>;
  'POST /api/v2/profiles/test': R<ProfileTestResult, { document: unknown; text: string }>;
  'GET /api/v2/profiles/suggestions': R<
    { suggestions: ProfileSuggestion[] },
    never,
    { repo: string }
  >;
  // 50-admin
  'GET /api/v2/repos': R<{ repos: KnownRepo[] }>;
  'POST /api/v2/repos': R<KnownRepo, { path: string }>;
  'GET /api/v2/repos/:id': R<RepoDetail>;
  'PUT /api/v2/repos/:id': R<RepoDetail, { pinned?: boolean; rules?: RepoRules }>;
  'GET /api/v2/requests': R<{ requests: AgentRequest[] }>;
  'GET /api/v2/requests/:workspaceId/:id': R<AgentRequestDetail>;
  'POST /api/v2/requests/:workspaceId/:id': R<AgentRequestDetail, AgentDecision>;
  'GET /api/v2/audit': R<AuditPage, never, { q?: string; cursor?: string; limit?: string }>;
  'POST /api/v2/audit/verify': R<AuditVerification>;
  'POST /api/v2/audit/export': R<{ jsonl: string; signature: string; publicKey: string }>;
  'GET /api/v2/settings': R<DashboardSettings>;
  'PUT /api/v2/settings': R<
    DashboardSettings,
    {
      workspacesRoot?: string;
      postCreateCommands?: string[];
      keyStorage?: SecuritySettings['keyStorage'];
      auditRetentionDays?: number | null;
      allowExclusionOverride?: boolean;
      autoLockMinutes?: number | null;
    }
  >;
  'POST /api/v2/settings/key/rotate': R<KeyRotationResult>;
  'POST /api/v2/settings/key/migrate': R<SessionInfo['store'], { target: KeyStorageKind }>;
};
export type LaunchQuery = {
  repo?: string | undefined;
  worktree?: string | undefined;
  workspace?: string | undefined;
  group?: string | undefined;
};
export type V2Route = keyof V2Api;
export type RouteParams<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | RouteParams<Rest>
  : Path extends `${string}:${infer Name}`
    ? Name
    : never;
