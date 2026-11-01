/**
 * Types only, shared with server-v2/home.ts. These are fields the 10-home screens need that
 * contracts.ts does not carry yet; each extends a contract type so routes stay assignable to it.
 */
import type {
  GroupBulkRequest,
  GroupDetail,
  GroupMember,
  GroupOperationState,
  OperationPreview,
  WorkspaceDetail,
  WorktreeOption,
} from '../../api/contracts.js';

export type WorkspaceDetailView = WorkspaceDetail & {
  profiles: string[];
  /** Tracked source files changed since the last pull; the overview only has a boolean. */
  sourceMovedFiles: number;
  worktrees: WorktreeOption[];
  main: { branch: string | null; sha: string | null } | null;
};
export type GroupMemberView = GroupMember & {
  worktree: string;
  tracked: number;
  worktrees: WorktreeOption[];
};
export type GroupDetailView = Omit<GroupDetail, 'members'> & { members: GroupMemberView[] };
/** A dry run or patch export carries the restored diff; it can never be applied. */
export type TargetPreview = OperationPreview & { patch?: string };
/** `members` narrows a bulk run to the checked rows; absent means every member. */
export type GroupBulkView = GroupBulkRequest & { members?: string[] };
export type GroupOperationView = GroupOperationState & { error?: string };
