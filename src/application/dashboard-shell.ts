import { basename, relative } from 'node:path';
import pLimit from 'p-limit';
import { createAgentStore } from '../adapters/agent-store.js';
import { exists } from '../adapters/files.js';
import { repoState } from '../adapters/git.js';
import { createGroupStore } from '../adapters/groups.js';
import { createProfileStore } from '../adapters/profiles.js';
import { createStatusIO } from '../adapters/status.js';
import type { createStore } from '../adapters/store.js';
import { createSyncStore } from '../adapters/sync-store.js';
import { version } from '../package.js';
import type {
  LaunchContext,
  LaunchQuery,
  Overview,
  OverviewWorkspace,
  SessionInfo,
  UiKind,
} from '../web/api/contracts.js';
import type { createDashboardSync } from './dashboard-sync.js';
import { runStatus } from './status.js';

export function createDashboardShell(
  store: ReturnType<typeof createStore>,
  sync: ReturnType<typeof createDashboardSync>,
) {
  const records = createSyncStore(store);
  const agents = createAgentStore(store);
  const groups = createGroupStore(store);
  const profiles = createProfileStore(store);
  const limit = pLimit(8);

  async function pendingRequests(workspaceId: string) {
    const doc = await agents.read(workspaceId).catch(() => undefined);
    return (doc?.requests ?? [])
      .flatMap((request) => request.files)
      .filter((file) => file.state === 'pending' || file.state === 'failed').length;
  }
  /** One unreadable or moved workspace must not take the whole dashboard down. */
  async function describeWorkspace(
    repo: { id: string; name: string; path: string },
    id: string,
    entry: { path: string; lastUsedAt: string; groupId?: string | undefined },
  ): Promise<OverviewWorkspace> {
    const name = basename(entry.path);
    const base = {
      id,
      repoId: repo.id,
      name,
      path: entry.path,
      groupId: entry.groupId ?? null,
      sourceMoved: false,
      pendingRequests: await pendingRequests(id),
      lastUsedAt: entry.lastUsedAt,
      lastPullAt: null,
      counts: { tracked: 0, modified: 0, added: 0, deleted: 0 },
      lineage: { repo, worktree: null, cloak: { id, name, path: entry.path } },
    };
    if (!(await exists(entry.path))) return { ...base, state: 'missing' };
    try {
      const snapshot = await records.readSnapshot(entry.path);
      if (!snapshot || snapshot.plain.workspaceId !== id) return { ...base, state: 'unreadable' };
      const status = await runStatus(createStatusIO(entry.path));
      const pulled = snapshot.data.pulls.at(-1)?.commit ?? snapshot.data.origin.commit;
      const head = await repoState(snapshot.data.origin.worktree).catch(() => undefined);
      const sourceMoved = !!head?.commit && !!pulled && head.commit !== pulled;
      const counts = {
        tracked: Object.keys(snapshot.plain.files).length,
        modified: status.modified.length,
        added: status.added.length,
        deleted: status.deleted.length,
      };
      return {
        ...base,
        counts,
        sourceMoved,
        lastPullAt: snapshot.plain.pulls.at(-1)?.at ?? null,
        state:
          counts.modified + counts.added + counts.deleted
            ? 'to-push'
            : sourceMoved
              ? 'source-moved'
              : 'clean',
        lineage: {
          ...base.lineage,
          worktree: {
            path: snapshot.data.origin.worktree,
            branch: head?.branch ?? snapshot.data.origin.branch,
            sha: head?.commit ?? pulled,
          },
        },
      };
    } catch {
      return { ...base, state: 'unreadable' };
    }
  }
  /** The query comes from the URL: only registered places are looked up or echoed back. */
  async function launchContext(
    query: LaunchQuery,
    data: Omit<Overview, 'launch'>,
  ): Promise<LaunchContext> {
    if (query.workspace) {
      const workspace = data.workspaces.find((item) => item.id === query.workspace);
      if (workspace)
        return {
          kind: 'workspace',
          repoId: workspace.repoId,
          workspaceId: workspace.id,
          label: workspace.name,
          path: workspace.path,
          branch: workspace.lineage.worktree?.branch ?? null,
        };
    }
    if (query.group) {
      const group = data.groups.find((item) => item.id === query.group);
      if (group)
        return {
          kind: 'group',
          groupId: group.id,
          label: `group ${group.name}`,
          path: null,
          branch: null,
        };
    }
    const repo = data.repos.find((item) => item.id === query.repo);
    if (!repo || repo.missing) return { kind: 'none' };
    const tree = (await sync.worktrees(repo.id).catch(() => [])).find(
      (item) => item.path === (query.worktree ?? repo.path),
    );
    if (!tree)
      return { kind: 'repo', repoId: repo.id, label: repo.name, path: repo.path, branch: null };
    const inner = relative(repo.path, tree.path);
    return {
      kind: 'repo',
      repoId: repo.id,
      label: inner ? `${repo.name}/${inner}` : repo.name,
      path: tree.path,
      branch: tree.branch,
    };
  }
  return {
    async session(ui: UiKind, port: number): Promise<SessionInfo> {
      const key = await store.keyStatus();
      return {
        app: 'repo-cloak',
        protocol: 1,
        version,
        ui,
        port,
        store: key,
        policy: { status: 'none', locked: [] },
      };
    },
    async overview(query: LaunchQuery): Promise<Overview> {
      const repos: Overview['repos'] = [];
      const pending: Promise<OverviewWorkspace>[] = [];
      for (const id of await store.listDirectories('repos')) {
        if (!/^[a-f0-9]{16}$/.test(id)) continue;
        const repo = await records.readRepo(id);
        if (!repo || repo.hidden) continue;
        const summary = { id, name: basename(repo.path), path: repo.path };
        const entries = Object.entries(repo.workspaces);
        repos.push({
          ...summary,
          missing: !(await exists(repo.path)),
          workspaceCount: entries.length,
        });
        for (const [workspaceId, entry] of entries)
          pending.push(limit(() => describeWorkspace(summary, workspaceId, entry)));
      }
      const workspaces = (await Promise.all(pending)).sort((a, b) =>
        b.lastUsedAt.localeCompare(a.lastUsedAt),
      );
      const groupList = await groups.list();
      const counted = groupList.map((group) => ({
        id: group.id,
        name: group.name,
        workspaceCount: group.members.length,
      }));
      const repoProfiles = await Promise.all(
        repos.map((repo) => profiles.list({ kind: 'repo', repoId: repo.id })),
      );
      const data = {
        repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
        groups: counted,
        workspaces,
        pendingAgentRequests: workspaces.reduce((sum, item) => sum + item.pendingRequests, 0),
        profileCount:
          (await profiles.list({ kind: 'global' })).length +
          repoProfiles.reduce((sum, list) => sum + list.length, 0),
        workspacesRoot: (await records.readConfig()).workspacesRoot ?? null,
      };
      return { ...data, launch: await launchContext(query, data) };
    },
  };
}
