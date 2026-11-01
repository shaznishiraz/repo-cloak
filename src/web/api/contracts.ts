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
