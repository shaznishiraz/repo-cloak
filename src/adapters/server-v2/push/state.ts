import type { Dashboard } from '../../../application/dashboard.js';
import type { PushApply } from '../../../web/api/contracts.js';

export const concurrency = 16;

export type Options = Omit<PushApply, 'operationId' | 'commitMessage'> & {
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
  options: Options;
};

/** Each dashboard keeps its own previews; they die with the operation they belong to. */
const pendingByDashboard = new WeakMap<Dashboard, Map<string, Pending>>();
export function pendingFor(dashboard: Dashboard) {
  let pending = pendingByDashboard.get(dashboard);
  if (!pending) pendingByDashboard.set(dashboard, (pending = new Map()));
  return pending;
}
