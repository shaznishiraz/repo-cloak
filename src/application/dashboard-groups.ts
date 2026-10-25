import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createStore } from '../adapters/store.js';
import { createGroupStore } from '../adapters/groups.js';
import { createGroupFolder } from '../adapters/group-folder.js';
import { canonicalPath } from '../adapters/files.js';
import { isWithin } from '../adapters/locations.js';
import { OperationError } from '../adapters/ui-operations.js';
import type { PreviewSummary, SyncResult, PreparedOperation } from '../adapters/ui-operations.js';
import { groupInputSchema } from '../core/groups.js';
import type { GroupMember } from '../core/groups.js';
import type { createDashboardSync } from './dashboard-sync.js';

type GroupSync = Pick<
  ReturnType<typeof createDashboardSync>,
  'operations' | 'prepareOperation' | 'worktrees' | 'workspaceTarget'
>;
type SavedGroup = NonNullable<Awaited<ReturnType<ReturnType<typeof createGroupStore>['read']>>>;
type MemberState = GroupMember & {
  summary: PreviewSummary;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'unattempted';
  result?: SyncResult;
  error?: string;
};
type Batch = {
  groupId: string;
  revision: string;
  intent: 'refresh' | 'restore';
  members: MemberState[];
};
const previewSchema = z
  .object({ revision: z.string().min(1), intent: z.enum(['refresh', 'restore']) })
  .strict();
const ackSchema = z
  .object({
    members: z
      .array(
        z
          .object({
            repoId: z.string().regex(/^[a-f0-9]{16}$/),
            deletions: z.boolean().optional(),
            profiles: z.boolean().optional(),
            force: z.boolean().optional(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();

export function createDashboardGroups(store: ReturnType<typeof createStore>, sync: GroupSync) {
  const groups = createGroupStore(store);
  const folders = createGroupFolder(store);
  const batches = new Map<string, Batch>();
  async function requireGroup(id: string, revision?: string) {
    const group = await groups.read(id);
    if (!group) throw new OperationError('validation', 'Group no longer exists');
    if (revision !== undefined && group.revision !== revision)
      throw new OperationError('stale', 'Group changed; refresh and review again');
    return group;
  }
  async function validateMembers(members: GroupMember[]) {
    const paths: string[][] = [];
    const normalized: GroupMember[] = [];
    for (const member of members) {
      const worktree = await canonicalPath(member.worktree);
      const trees = await sync.worktrees(member.repoId);
      const valid = await Promise.all(trees.map((tree) => canonicalPath(tree.path)));
      if (!valid.includes(worktree))
        throw new OperationError('validation', 'Select a worktree belonging to this repository');
      const workspace = await sync.workspaceTarget(member.repoId, member.workspaceId);
      const current = [worktree, workspace.path];
      if (
        paths.some((previous) =>
          previous.some((a) =>
            current.some(
              (b) =>
                isWithin(a.toLowerCase(), b.toLowerCase()) ||
                isWithin(b.toLowerCase(), a.toLowerCase()),
            ),
          ),
        )
      )
        throw new OperationError(
          'validation',
          'Group members must not have overlapping source or workspace folders',
        );
      paths.push(current);
      normalized.push({ ...member, worktree });
    }
    return normalized;
  }
  function getBatch(id: string) {
    // The shared operation manager expires plans and bounds retained results.
    for (const key of batches.keys()) {
      try {
        sync.operations.status(key);
      } catch {
        batches.delete(key);
      }
    }
    const batch = batches.get(id);
    if (!batch)
      throw new OperationError('unknown', 'Unknown group sync; refresh and prepare again');
    return batch;
  }
  function status(id: string) {
    const batch = getBatch(id);
    return { ...sync.operations.status(id), ...structuredClone(batch) };
  }
  async function previewGroup(
    group: SavedGroup,
    intent: Batch['intent'],
    selected = group.members,
  ) {
    const members = await validateMembers(selected);
    const batch: Batch = { groupId: group.id, revision: group.revision, intent, members: [] };
    const preview = await sync.operations.preview(async () => {
      const prepared: PreparedOperation[] = [];
      for (const member of members) {
        const operation = await sync.prepareOperation({ ...member, intent });
        prepared.push(operation);
        batch.members.push({ ...member, summary: operation.summary, state: 'pending' });
      }
      await requireGroup(group.id, group.revision);
      const first = prepared[0];
      if (!first) throw new OperationError('validation', 'Choose at least one group member');
      const summaries = prepared.map((operation) => operation.summary);
      const summary: PreviewSummary = {
        ...first.summary,
        writes: summaries.flatMap((item) => item.writes),
        deletes: summaries.flatMap((item) => item.deletes),
        conflicts: summaries.flatMap((item) => item.conflicts),
        warnings: summaries.flatMap((item) => item.warnings),
        profileChanges: summaries.flatMap((item) => item.profileChanges),
        replacements: summaries.reduce((sum, item) => sum + item.replacements, 0),
        redactions: summaries.reduce((sum, item) => sum + item.redactions, 0),
        canApply: summaries.every((item) => item.canApply),
        forced: summaries.some((item) => item.forced),
      };
      return {
        owner: 'group' as const,
        summary,
        bytes: prepared.reduce((sum, operation) => sum + operation.bytes, 0),
        async apply() {
          try {
            await requireGroup(group.id, group.revision);
            await validateMembers(members);
            for (const operation of prepared) await operation.recheck?.();
          } catch (error) {
            for (const member of batch.members) member.state = 'unattempted';
            throw error;
          }
          let total: SyncResult | undefined;
          for (const [index, operation] of prepared.entries()) {
            const member = batch.members[index];
            if (!member) throw new Error('Group operation has no matching member');
            member.state = 'running';
            try {
              const result = await operation.apply();
              member.result = result;
              member.state = 'completed';
              total = total
                ? {
                    ...total,
                    writes: [...total.writes, ...result.writes],
                    deletes: [...total.deletes, ...result.deletes],
                    warnings: [...total.warnings, ...result.warnings],
                    profileChanges: [...total.profileChanges, ...result.profileChanges],
                    replacements: total.replacements + result.replacements,
                    skipped: total.skipped + result.skipped,
                  }
                : { ...result };
            } catch (error) {
              member.state = 'failed';
              member.error = error instanceof Error ? error.message : 'Sync failed';
              for (const remaining of batch.members.slice(index + 1))
                remaining.state = 'unattempted';
              throw new Error(
                `${index} succeeded / 1 failed / ${prepared.length - index - 1} unattempted: ${member.error}`,
                { cause: error },
              );
            }
          }
          if (!total) throw new Error('Group has no completed members');
          return total;
        },
      };
    });
    // Prune metadata on every new batch as well as on reads.
    for (const id of batches.keys()) {
      try {
        sync.operations.status(id);
      } catch {
        batches.delete(id);
      }
    }
    batches.set(preview.operationId, batch);
    return { ...preview, ...structuredClone(batch) };
  }
  return {
    list: groups.list,
    async save(value: unknown, id?: string, revision?: string) {
      const input = groupInputSchema
        .extend({
          copyWorkspaces: z.boolean().optional(),
          folderRoot: z.string().trim().min(1).optional(),
        })
        .parse(value);
      return sync.operations.exclusive(() =>
        groups.locked(async () => {
          const previous = id ? await requireGroup(id, revision ?? '') : undefined;
          const members = await validateMembers(input.members);
          const group = {
            kind: 'group',
            schemaVersion: 1,
            id: id ?? randomUUID(),
            name: input.name,
            members,
            ...(previous?.folder ? { folder: previous.folder } : {}),
          } as const;
          if (input.copyWorkspaces || previous?.folder) {
            const targets = await Promise.all(
              members.map(async (member) => ({
                ...member,
                ...(await sync.workspaceTarget(member.repoId, member.workspaceId)),
              })),
            );
            return folders.save(group, targets, input.folderRoot, groups.write);
          }
          return groups.write(group);
        }),
      );
    },
    async remove(id: string, revision: string) {
      return sync.operations.exclusive(() =>
        groups.locked(async () => {
          await requireGroup(id, revision);
          await groups.remove(id);
          return { deleted: id };
        }),
      );
    },
    async preview(id: string, value: unknown) {
      const input = previewSchema.parse(value);
      return previewGroup(await requireGroup(id, input.revision), input.intent);
    },
    async apply(id: string, value: unknown) {
      const batch = getBatch(id);
      if (sync.operations.status(id).state !== 'pending') return status(id);
      const input = ackSchema.parse(value);
      if (
        new Set(input.members.map((member) => member.repoId)).size !== input.members.length ||
        input.members.some((ack) => !batch.members.some((member) => member.repoId === ack.repoId))
      )
        throw new OperationError('validation', 'Acknowledgements must name unique batch members');
      for (const member of batch.members) {
        const ack = input.members.find((item) => item.repoId === member.repoId);
        if (member.summary.deletes.length && !ack?.deletions)
          throw new OperationError('validation', `Confirm deletions for ${member.repoId}`);
        if (member.summary.profileChanges.length && !ack?.profiles)
          throw new OperationError('validation', `Confirm changed profiles for ${member.repoId}`);
        if (member.summary.forced && !ack?.force)
          throw new OperationError('validation', `Confirm forced overwrites for ${member.repoId}`);
      }
      await groups.locked(async () => {
        await requireGroup(batch.groupId, batch.revision);
        await sync.operations.apply(id, { deletions: true, profiles: true, force: true }, 'group');
      });
      return status(id);
    },
    status,
    cancel(id: string) {
      getBatch(id);
      sync.operations.cancel(id);
      return status(id);
    },
    async wait(id: string) {
      getBatch(id);
      await sync.operations.wait(id);
      return status(id);
    },
    async retry(id: string) {
      const batch = getBatch(id);
      if (sync.operations.status(id).state !== 'failed')
        throw new OperationError('validation', 'Only a failed batch can be retried');
      const group = await requireGroup(batch.groupId, batch.revision);
      const remaining = batch.members.filter((member) => member.state !== 'completed');
      return previewGroup(
        group,
        batch.intent,
        remaining.map(({ repoId, workspaceId, worktree }) => ({ repoId, workspaceId, worktree })),
      );
    },
  };
}
