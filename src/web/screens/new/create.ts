import type { LaunchQuery, NewCloakCreate, Overview, OperationState } from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { overview } from '../../shell/state.js';

export type GroupChoice =
  { kind: 'none' } | { kind: 'existing'; id: string } | { kind: 'new'; name: string };

function launchQuery(data: Overview | null): LaunchQuery {
  const launch = data?.launch;
  if (launch?.kind === 'repo') return { repo: launch.repoId, worktree: launch.path };
  if (launch?.kind === 'workspace') return { workspace: launch.workspaceId };
  if (launch?.kind === 'group') return { group: launch.groupId };
  return {};
}
/** The rail and home read this signal, so they should not wait for the next poll. */
export async function refreshOverview() {
  overview.value = await api().call('GET /api/v2/overview', {
    query: launchQuery(overview.value),
  });
}

const pollEvery = 400;
async function finished(state: OperationState) {
  let current = state;
  while (current.state === 'running' || current.state === 'pending') {
    await new Promise((done) => setTimeout(done, pollEvery));
    current = await api().call('GET /api/v2/operations/:id', {
      params: { id: current.operationId },
    });
  }
  return current;
}

/**
 * Per design/repository-groups.md the cloak is created standalone and joins afterwards. A failed
 * join reports that and keeps the cloak.
 */
async function joinGroup(
  choice: GroupChoice,
  member: { repoId: string; workspaceId: string; worktree: string },
) {
  if (choice.kind === 'none') return null;
  try {
    if (choice.kind === 'new') {
      await api().call('POST /api/v2/groups', {
        body: { name: choice.name, members: [member] },
      });
      return null;
    }
    const { revision } = await api().call('GET /api/v2/groups/:id', {
      params: { id: choice.id },
    });
    await api().call('POST /api/v2/groups/:id/members', {
      params: { id: choice.id },
      body: { revision, member },
    });
    return null;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'the group could not be changed';
    return `Cloak created, but it could not join the group: ${reason}`;
  }
}

export type CreateOutcome = {
  workspaceId: string;
  files: number;
  warnings: string[];
};

/** Preview, apply, wait. The aside was the review, so a clean preview applies straight away. */
export async function runCreate(body: NewCloakCreate, group: GroupChoice): Promise<CreateOutcome> {
  const preview = await api().call('POST /api/v2/new/create', { body });
  const { operationId, summary } = preview;
  const stop = () =>
    api()
      .call('DELETE /api/v2/operations/:id', { params: { id: operationId } })
      .catch(() => undefined);
  if (!summary.canApply) {
    await stop();
    throw new Error(summary.conflicts[0] ?? 'This cloak cannot be created; review and try again');
  }
  let state: OperationState;
  try {
    state = await api().call('POST /api/v2/operations/:id/apply', {
      params: { id: operationId },
      body: { profiles: true },
    });
  } catch (cause) {
    await stop();
    throw cause;
  }
  const done = await finished(state);
  if (done.state !== 'completed' || !done.result)
    throw new Error(done.error ?? `The operation ended as ${done.state}`);
  const joinProblem = await joinGroup(group, {
    repoId: body.repoId,
    workspaceId: done.result.workspaceId,
    worktree: body.worktree,
  });
  await refreshOverview().catch(() => undefined);
  return {
    workspaceId: done.result.workspaceId,
    files: done.result.writes.length,
    warnings: [...done.result.warnings, ...(joinProblem ? [joinProblem] : [])],
  };
}
