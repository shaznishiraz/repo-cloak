import { basename } from 'node:path';
import type { Dashboard } from '../../../application/dashboard.js';
import type { PostCheckRun, PostCheckView } from '../../../web/api/contracts.js';
import { canonicalPath } from '../../files.js';
import { runCheckCommand } from '../../post-check.js';
import { OperationError } from '../../ui-operations.js';
import { maskSecrets } from './diff.js';
import { pushedTo } from './state.js';

const defaultTimeoutSeconds = 600;

/** Runs live in this process's memory only, and one command runs at a time. */
type Runs = { latest: Map<string, PostCheckRun>; active: boolean };
const runsByDashboard = new WeakMap<Dashboard, Runs>();
function runsOf(dashboard: Dashboard) {
  let runs = runsByDashboard.get(dashboard);
  if (!runs) runsByDashboard.set(dashboard, (runs = { latest: new Map(), active: false }));
  return runs;
}

export async function postCheckView(
  dashboard: Dashboard,
  repoId: string,
  workspaceId: string,
): Promise<PostCheckView> {
  const saved = await dashboard.sync.postCheck(repoId);
  return {
    command: saved?.command ?? null,
    timeoutSeconds: saved?.timeoutSeconds ?? defaultTimeoutSeconds,
    canRun: !!saved && pushedTo(dashboard).has(workspaceId),
    run: runsOf(dashboard).latest.get(workspaceId) ?? null,
  };
}

/**
 * The only way a post-check starts: an explicit request, for the command the screen showed, after
 * a push this process completed. The worktree comes from that push, never from the request.
 */
export async function startPostCheck(
  dashboard: Dashboard,
  repoId: string,
  workspaceId: string,
  command: string,
): Promise<PostCheckRun> {
  const { path: workspace, snapshot } = await dashboard.sync.workspaceTarget(repoId, workspaceId);
  const saved = await dashboard.sync.postCheck(repoId);
  if (!saved) throw new OperationError('validation', 'No post-check command is configured');
  if (saved.command !== command)
    throw new OperationError('conflict', 'The post-check command changed; review it and try again');
  const root = pushedTo(dashboard).get(workspaceId);
  if (!root) throw new OperationError('conflict', 'A post-check runs only after a push');
  const trees = await Promise.all(
    (await dashboard.sync.worktrees(repoId)).map((tree) => canonicalPath(tree.path)),
  );
  const cwd = await canonicalPath(root).catch(() => undefined);
  if (!cwd || !trees.includes(cwd))
    throw new OperationError('conflict', 'The worktree this push went to no longer exists');
  const runs = runsOf(dashboard);
  if (runs.active) throw new OperationError('busy', 'A post-check is already running');
  runs.active = true;
  const running: PostCheckRun = {
    state: 'running',
    exitCode: null,
    durationMs: 0,
    output: '',
    truncated: false,
  };
  runs.latest.set(workspaceId, running);
  const { ledger } = snapshot.data;
  void runCheckCommand(command, cwd, saved.timeoutSeconds * 1000)
    .then(async (result) => {
      runs.latest.set(workspaceId, { ...result, output: maskSecrets(result.output, ledger) });
      // Outcome only: the command and its output can hold anything.
      await dashboard.sync.audit.record({
        op: 'push',
        outcome: result.state === 'passed' ? 'ok' : 'failed',
        workspace: { repoId, id: workspaceId, name: basename(workspace) },
        detail:
          result.state === 'passed'
            ? 'Post-check passed'
            : result.state === 'timed-out'
              ? 'Post-check timed out'
              : `Post-check failed (exit ${result.exitCode ?? 'none'})`,
      });
    })
    .finally(() => {
      runs.active = false;
    });
  return running;
}
