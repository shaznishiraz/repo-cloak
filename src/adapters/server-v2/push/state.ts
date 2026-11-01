import type { Dashboard } from '../../../application/dashboard.js';
import type { GuardCheck, PushApply } from '../../../web/api/contracts.js';

export const concurrency = 16;

export type Options = Omit<
  PushApply,
  'operationId' | 'commitMessage' | 'paths' | 'confirmDeletes' | 'confirmOverwrites'
> & {
  message: string | undefined;
};
export const defaultOptions: Options = {
  mode: 'write',
  message: undefined,
  repull: false,
  includeGroupMembers: false,
  mergeMode: 'merge',
};
export type Pending = {
  repoId: string;
  workspaceId: string;
  /** Restored path to merged bytes, or null when the two sides overlap. */
  merges: Map<string, Uint8Array | null>;
  /** What the review listed, cloaked path to restored path. Nothing else can be selected. */
  files: Map<string, string>;
  /** Restored paths the full review would delete. */
  deletes: string[];
  workspace: string;
  isNewTree: boolean;
  options: Options;
};

/** Each dashboard keeps its own previews; they die with the operation they belong to. */
const pendingByDashboard = new WeakMap<Dashboard, Map<string, Pending>>();
export function pendingFor(dashboard: Dashboard) {
  let pending = pendingByDashboard.get(dashboard);
  if (!pending) pendingByDashboard.set(dashboard, (pending = new Map()));
  return pending;
}

/** What recovery found, shown on the review until the next push or undo in this process. */
const noticesByDashboard = new WeakMap<Dashboard, Map<string, GuardCheck[]>>();
export function noticesFor(dashboard: Dashboard) {
  let notices = noticesByDashboard.get(dashboard);
  if (!notices) noticesByDashboard.set(dashboard, (notices = new Map()));
  return notices;
}
/** The worktree of the last completed push; only this makes a post-check available. */
const pushesByDashboard = new WeakMap<Dashboard, Map<string, string>>();
export function pushedTo(dashboard: Dashboard) {
  let pushes = pushesByDashboard.get(dashboard);
  if (!pushes) pushesByDashboard.set(dashboard, (pushes = new Map()));
  return pushes;
}
export function forgetPush(dashboard: Dashboard, workspaceId: string) {
  pushedTo(dashboard).delete(workspaceId);
}
