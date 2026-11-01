import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { z } from 'zod';
import { createStore } from '../adapters/store.js';
import { commitPaths } from '../adapters/git.js';
import { createGroupStore } from '../adapters/groups.js';
import type { GroupLock } from '../adapters/groups.js';
import { createGroupFolder } from '../adapters/group-folder.js';
import { canonicalPath } from '../adapters/files.js';
import { isWithin } from '../adapters/locations.js';
import { OperationError } from '../adapters/ui-operations.js';
import type { PreviewSummary, SyncResult, PreparedOperation } from '../adapters/ui-operations.js';
import { groupInputSchema, groupMemberSchema } from '../core/groups.js';
import { createReplacer } from '../core/replacer.js';
import type { GroupMember } from '../core/groups.js';
import type { createDashboardSync } from './dashboard-sync.js';

type GroupSync = Pick<
  ReturnType<typeof createDashboardSync>,
  'audit' | 'operations' | 'prepareOperation' | 'worktrees' | 'workspaceTarget'
>;
type SavedGroup = NonNullable<Awaited<ReturnType<ReturnType<typeof createGroupStore>['read']>>>;
type MemberState = GroupMember & {
  /** Absent when the member was skipped because it could not be prepared. */
  summary?: PreviewSummary;
  state: 'pending' | 'running' | 'completed' | 'failed' | 'unattempted';
  result?: SyncResult;
  /** Written by an attempt whose commit failed; a retry must still commit them. */
  uncommitted?: string[];
  error?: string;
};
type RunRules = { stopOnGuardFailure: boolean; commitMessage?: string };
type Batch = RunRules & {
  groupId: string;
  revision: string;
  intent: 'refresh' | 'restore';
  members: MemberState[];
};
const repoIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const previewSchema = z
  .object({
    revision: z.string().min(1),
    intent: z.enum(['refresh', 'restore']),
    members: z.array(repoIdSchema).min(1).max(8).optional(),
    stopOnGuardFailure: z.boolean().optional(),
    commitMessage: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine((input) => !input.commitMessage || input.intent === 'restore', {
    message: 'Only a push can commit',
    path: ['commitMessage'],
  });
const ackSchema = z
  .object({
    members: z
      .array(
        z
          .object({
            repoId: repoIdSchema,
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
  // Only one run at a time holds the lock, so one slot is enough.
  let runLock: GroupLock | undefined;
  let releasing: Promise<void> = Promise.resolve();
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
  /** Commit messages are typed against cloaked names; each member's source gets its real ones. */
  async function restoredMessage(member: MemberState, message: string) {
    const { snapshot } = await sync.workspaceTarget(member.repoId, member.workspaceId);
    const restored = createReplacer(snapshot.data.rules).restore(message, snapshot.data.ledger, {
      file: 'commit message',
      scope: 'content',
    });
    if (restored.preview.some((match) => match.kind === 'secret'))
      throw new OperationError('validation', 'The commit message must not contain a secret');
    return restored.text;
  }
  async function commitMember(member: MemberState, result: SyncResult, message: string) {
    const paths = [
      ...new Set([...(member.uncommitted ?? []), ...result.writes, ...result.deletes]),
    ];
    member.uncommitted = paths;
    const { commit, warnings } = await commitPaths(
      member.worktree,
      paths,
      await restoredMessage(member, message),
    );
    delete member.uncommitted;
    if (commit)
      await sync.audit.record({
        op: 'push',
        outcome: 'ok',
        workspace: {
          repoId: member.repoId,
          id: member.workspaceId,
          name: basename(result.workspace),
        },
        detail: `Committed ${commit}`,
      });
    return { ...result, warnings: [...result.warnings, ...warnings] };
  }
  async function previewGroup(
    group: SavedGroup,
    intent: Batch['intent'],
    selected: (GroupMember & Pick<MemberState, 'uncommitted'>)[],
    rules: RunRules,
  ) {
    const stop = rules.stopOnGuardFailure;
    if (stop) await validateMembers(selected);
    const batch: Batch = {
      groupId: group.id,
      revision: group.revision,
      intent,
      ...rules,
      members: [],
    };
    const preview = await sync.operations.preview(async () => {
      const ready: { member: MemberState; operation: PreparedOperation }[] = [];
      const skipped: string[] = [];
      for (const choice of selected) {
        const member: MemberState = { ...choice, state: 'pending' };
        batch.members.push(member);
        try {
          const [valid] = await validateMembers([choice]);
          if (valid) member.worktree = valid.worktree;
          const operation = await sync.prepareOperation({
            repoId: member.repoId,
            workspaceId: member.workspaceId,
            worktree: member.worktree,
            intent,
          });
          const { summary } = operation;
          if (!stop && !summary.canApply)
            throw new Error(`conflicts in ${summary.conflicts.slice(0, 3).join(', ')}`);
          member.summary = summary;
          ready.push({ member, operation });
        } catch (error) {
          if (stop) throw error;
          member.state = 'unattempted';
          member.error = error instanceof Error ? error.message : 'Could not prepare';
          skipped.push(`Skipped ${basename(member.worktree)}: ${member.error}`);
        }
      }
      await validateMembers(ready.map(({ member }) => member));
      await requireGroup(group.id, group.revision);
      if (stop && !ready.length)
        throw new OperationError('validation', 'Choose at least one group member');
      const summaries = ready.map(({ operation }) => operation.summary);
      const summary: PreviewSummary = {
        intent,
        source: { path: group.name, branch: null },
        destination: { path: group.name, branch: null },
        postCreateCommands: [],
        ...summaries[0],
        writes: summaries.flatMap((item) => item.writes),
        deletes: summaries.flatMap((item) => item.deletes),
        conflicts: summaries.flatMap((item) => item.conflicts),
        warnings: [...skipped, ...summaries.flatMap((item) => item.warnings)],
        profileChanges: summaries.flatMap((item) => item.profileChanges),
        replacements: summaries.reduce((sum, item) => sum + item.replacements, 0),
        redactions: summaries.reduce((sum, item) => sum + item.redactions, 0),
        canApply: ready.length > 0 && summaries.every((item) => item.canApply),
        forced: summaries.some((item) => item.forced),
      };
      return {
        owner: 'group' as const,
        summary,
        bytes: ready.reduce((sum, { operation }) => sum + operation.bytes, 0),
        async apply() {
          const unattempted = (from: number) => {
            for (const { member } of ready.slice(from)) member.state = 'unattempted';
          };
          try {
            await requireGroup(group.id, group.revision);
            await validateMembers(ready.map(({ member }) => member));
            for (const { member, operation } of ready) {
              await operation.recheck?.();
              // Refuse a bad message before anything is written, not after the first member.
              if (rules.commitMessage) await restoredMessage(member, rules.commitMessage);
            }
          } catch (error) {
            unattempted(0);
            throw error;
          }
          let total: SyncResult | undefined;
          let failed = 0;
          for (const [index, { member, operation }] of ready.entries()) {
            try {
              runLock?.assertHeld();
            } catch (error) {
              unattempted(index);
              throw error;
            }
            member.state = 'running';
            try {
              const written = await operation.apply();
              const result = rules.commitMessage
                ? await commitMember(member, written, rules.commitMessage)
                : written;
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
              failed++;
              if (!stop) continue;
              unattempted(index + 1);
              throw new Error(
                `${index} succeeded / 1 failed / ${ready.length - index - 1} unattempted: ${member.error}`,
                { cause: error },
              );
            }
          }
          if (failed) throw new Error(`${failed} member${failed === 1 ? '' : 's'} failed`);
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
  async function saveGroup(value: unknown, id?: string, revision?: string) {
    const input = groupInputSchema
      .extend({
        moveWorkspaces: z.boolean().optional(),
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
        if (input.moveWorkspaces || previous?.folder) {
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
  }
  return {
    list: groups.list,
    save: saveGroup,
    async join(id: string, value: unknown) {
      const input = z
        .object({ revision: z.string().min(1), member: groupMemberSchema })
        .strict()
        .parse(value);
      const group = await requireGroup(id);
      const existing = group.members.find((item) => item.repoId === input.member.repoId);
      if (existing && existing.workspaceId !== input.member.workspaceId)
        throw new OperationError(
          'validation',
          'This group already contains a workspace for this repository; use Edit group to change it',
        );
      const [member] = await validateMembers([input.member]);
      if (!member) throw new OperationError('validation', 'Choose a group member');
      if (existing) {
        if (existing.workspaceId === member.workspaceId && existing.worktree === member.worktree)
          return group;
        throw new OperationError(
          'validation',
          'This group already contains a workspace for this repository; use Edit group to change it',
        );
      }
      // A group with a folder moves the new member in; one without stays where everyone is.
      return saveGroup(
        { name: group.name, members: [...group.members, member] },
        id,
        input.revision,
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
      const group = await requireGroup(id, input.revision);
      const chosen = input.members;
      if (chosen?.some((repoId) => !group.members.some((item) => item.repoId === repoId)))
        throw new OperationError('validation', 'A chosen member is not in this group');
      return previewGroup(
        group,
        input.intent,
        chosen ? group.members.filter((item) => chosen.includes(item.repoId)) : group.members,
        {
          stopOnGuardFailure: input.stopOnGuardFailure ?? true,
          ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
        },
      );
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
        const { summary } = member;
        if (!summary) continue;
        if (summary.deletes.length && !ack?.deletions)
          throw new OperationError('validation', `Confirm deletions for ${member.repoId}`);
        if (summary.profileChanges.length && !ack?.profiles)
          throw new OperationError('validation', `Confirm changed profiles for ${member.repoId}`);
        if (summary.forced && !ack?.force)
          throw new OperationError('validation', `Confirm forced overwrites for ${member.repoId}`);
      }
      // operations.apply only schedules the run, so the hold is released when the run settles.
      const held = await groups.acquire();
      try {
        await requireGroup(batch.groupId, batch.revision);
        runLock = held;
        await sync.operations.apply(id, { deletions: true, profiles: true, force: true }, 'group');
      } catch (error) {
        runLock = undefined;
        await held.release();
        throw error;
      }
      releasing = sync.operations
        .wait(id)
        .then(() => {
          runLock = undefined;
          return held.release();
        })
        // An unreleased lock goes stale by itself, and the run's own result is what matters.
        .catch(() => undefined);
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
      await releasing;
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
        remaining.map(({ repoId, workspaceId, worktree, uncommitted }) => ({
          repoId,
          workspaceId,
          worktree,
          ...(uncommitted ? { uncommitted } : {}),
        })),
        {
          stopOnGuardFailure: batch.stopOnGuardFailure,
          ...(batch.commitMessage ? { commitMessage: batch.commitMessage } : {}),
        },
      );
    },
  };
}
