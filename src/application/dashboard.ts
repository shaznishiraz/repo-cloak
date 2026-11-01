import { createDashboardSettings } from './dashboard-settings.js';
import { createDashboardSync } from './dashboard-sync.js';
import { createDashboardGroups } from './dashboard-groups.js';
import { createAgentRequests } from './agent-requests.js';
import { createDashboardShell } from './dashboard-shell.js';
import { createAgentClientConfig } from '../adapters/agent-client-config.js';
import { createAgentStore } from '../adapters/agent-store.js';
import { createGroupStore } from '../adapters/groups.js';
import { createDesktop } from '../adapters/desktop.js';
import { OperationError } from '../adapters/ui-operations.js';
import { basename } from 'node:path';
import { z } from 'zod';
import { createStore } from '../adapters/store.js';
import { createSyncStore } from '../adapters/sync-store.js';
import { createProfileStore } from '../adapters/profiles.js';
import { createStatusIO } from '../adapters/status.js';
import { findRepo, repoState } from '../adapters/git.js';
import { canonicalPath, exists, checkDestinationPath } from '../adapters/files.js';
import { isWithin } from '../adapters/locations.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runStatus } from './status.js';
import { documentSchema } from '../core/schemas.js';
import { validateProfile } from '../core/rules.js';
import { mergeProfiles } from '../core/merge.js';
import type { ProfileScope } from '../core/profiles.js';

const repoIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('repo'), repoId: repoIdSchema }),
]);
const referenceSchema = z.object({ id: z.string().min(1), scope: scopeSchema });
const saveSchema = referenceSchema.omit({ id: true }).extend({
  id: z.string().min(1).optional(),
  profile: documentSchema.profile,
});

export function createDashboard(
  store = createStore(),
  cwd = process.cwd(),
  desktop = createDesktop(),
) {
  const syncStore = createSyncStore(store);
  const profiles = createProfileStore(store);
  async function requireScope(scope: ProfileScope) {
    if (scope.kind === 'repo') {
      const repo = await syncStore.readRepo(scope.repoId);
      if (!repo || repo.hidden) throw new Error('Repository is not registered');
    }
  }
  async function findProfile(value: unknown) {
    const ref = referenceSchema.parse(value);
    await requireScope(ref.scope);
    const saved = (await profiles.list(ref.scope)).find((profile) => profile.id === ref.id);
    if (!saved) throw new Error('Profile no longer exists');
    return saved;
  }
  const sync = createDashboardSync(store);
  const clientConfig = createAgentClientConfig();
  const agentStore = createAgentStore(store);
  const groupStore = createGroupStore(store);
  return {
    shell: createDashboardShell(store, sync),
    sync,
    groups: createDashboardGroups(store, sync),
    agents: createAgentRequests(store, sync),
    desktop: {
      availability: desktop.availability,
      async openWorkspace(repoId: string, workspaceId: string, value: unknown) {
        const { target } = z
          .object({ target: z.enum(['folder', 'vscode', 'zed', 'orca']) })
          .strict()
          .parse(value);
        const workspace = await sync.workspaceTarget(repoId, workspaceId);
        return desktop.open(workspace.path, target);
      },
      async openGroup(id: string, value: unknown) {
        const { target } = z
          .object({ target: z.enum(['folder', 'vscode', 'zed', 'orca']) })
          .strict()
          .parse(value);
        const group = await groupStore.read(id);
        if (
          !group?.folder ||
          !(await exists(group.folder)) ||
          (await canonicalPath(group.folder)) !== group.folder
        )
          throw new Error('Create or restore this group folder before opening it');
        await checkDestinationPath(group.folder, '.repo-cloak/group.json');
        const metadata = JSON.parse(
          await readFile(join(group.folder, '.repo-cloak/group.json'), 'utf8'),
        ) as { groupId?: string };
        if (metadata.groupId !== id) throw new Error('Group folder identity changed');
        return desktop.open(group.folder, target);
      },
    },
    async agentClientConfig(repoId: string, workspaceId: string) {
      const target = await sync.workspaceTarget(repoId, workspaceId);
      return clientConfig.info(workspaceId, target.path);
    },
    async installAgentClient(
      repoId: string,
      workspaceId: string,
      provider: string,
      value: unknown,
    ) {
      z.object({ confirm: z.literal(true) })
        .strict()
        .parse(value);
      const client = z.enum(['codex', 'claude']).parse(provider);
      const target = await sync.workspaceTarget(repoId, workspaceId);
      return clientConfig.install(client, workspaceId, target.path);
    },
    settings: createDashboardSettings(store, sync.audit),
    async removeRepository(value: string) {
      const repoId = repoIdSchema.parse(value);
      return sync.operations.exclusive(() =>
        groupStore.locked(async () => {
          if (!(await syncStore.readRepo(repoId)))
            throw new OperationError('unknown', 'Repository is not registered');
          for (const group of await groupStore.list()) {
            const members = group.members.filter((member) => member.repoId !== repoId);
            if (members.length === group.members.length) continue;
            if (members.length) {
              const { revision, ...record } = group;
              void revision;
              await groupStore.write({ ...record, members });
            } else await groupStore.remove(group.id);
          }
          await syncStore.setRepoHidden(repoId, true);
          return { removed: repoId };
        }),
      );
    },
    async deleteWorkspace(repoId: string, id: string, value: unknown) {
      const input = z
        .object({ path: z.string().min(1), confirm: z.literal(true) })
        .strict()
        .parse(value);
      const result = await sync.deleteWorkspace(
        repoIdSchema.parse(repoId),
        z.string().min(1).parse(id),
        input.path,
      );
      await agentStore.locked(id, async () => {
        const doc = await agentStore.read(id);
        if (doc) await store.remove(`agents/${id}.json`);
      });
      return result;
    },
    async addRepository(value: unknown) {
      const { path } = z
        .object({ path: z.string().min(1) })
        .strict()
        .parse(value);
      const canonical = await canonicalPath(path);
      if (await syncStore.findWorkspace(canonical))
        throw new Error('Choose a source repository, not a cloak workspace');
      const repo = await findRepo(canonical);
      if (!repo) throw new Error('The selected folder is not a Git repository');
      await syncStore.registerRepo(await repoState(repo.topLevel));
      return { repoId: repo.repoId, worktree: repo.topLevel };
    },
    validateProfile(value: unknown) {
      return validateProfile(value);
    },
    async context() {
      const workspace = await syncStore.findWorkspace(cwd);
      if (workspace) {
        const snapshot = await syncStore.readSnapshot(workspace);
        if (snapshot && (await syncStore.readRepo(snapshot.plain.source.repoId))?.hidden)
          await syncStore.setRepoHidden(snapshot.plain.source.repoId, false);
        return {
          repoId: snapshot?.plain.source.repoId,
          workspaceId: snapshot?.plain.workspaceId,
          worktree: snapshot?.data.source.path,
        };
      }
      const path = await canonicalPath(cwd);
      for (const group of await groupStore.list())
        if (group.folder && isWithin(group.folder, path) && (await exists(group.folder)))
          return { groupId: group.id };
      const repo = await findRepo(cwd);
      if (repo) await syncStore.registerRepo(await repoState(repo.topLevel));
      return { repoId: repo?.repoId, worktree: repo?.topLevel };
    },
    async overview() {
      const repos = [];
      for (const id of await store.listDirectories('repos')) {
        if (!repoIdSchema.safeParse(id).success) continue;
        const repo = await syncStore.readRepo(id);
        if (!repo || repo.hidden) continue;
        const workspaces = await Promise.all(
          Object.entries(repo.workspaces).map(async ([id, workspace]) => ({
            id,
            name: basename(workspace.path),
            path: workspace.path,
            lastUsedAt: workspace.lastUsedAt,
            lastProfiles: workspace.lastProfiles,
            groupId: workspace.groupId,
            worktree: workspace.target?.worktree ?? workspace.origin?.worktree,
            missing: !(await exists(workspace.path)),
            pendingRequests:
              (await agentStore.read(id))?.requests.reduce(
                (sum, request) =>
                  sum +
                  request.files.filter(
                    (file) => file.state === 'pending' || file.state === 'failed',
                  ).length,
                0,
              ) ?? 0,
          })),
        );
        repos.push({
          id,
          name: basename(repo.path),
          path: repo.path,
          missing: !(await exists(repo.path)),
          workspaces: workspaces.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)),
        });
      }
      return repos.sort((a, b) => a.name.localeCompare(b.name));
    },
    async workspace(repoId: string, id: string) {
      const repo = await syncStore.readRepo(repoIdSchema.parse(repoId));
      const workspace =
        repo && !repo.hidden && Object.hasOwn(repo.workspaces, id)
          ? repo.workspaces[id]
          : undefined;
      if (!workspace) throw new Error('Workspace is not registered');
      const snapshot = await syncStore.readSnapshot(workspace.path);
      if (!snapshot || snapshot.plain.source.repoId !== repoId || snapshot.plain.workspaceId !== id)
        throw new Error('Workspace manifest is missing or belongs to another workspace');
      return {
        id,
        name: basename(workspace.path),
        path: workspace.path,
        status: await runStatus(createStatusIO(workspace.path)),
        history: [...snapshot.plain.pulls].reverse(),
        targetBranch: snapshot.data.target.branch,
        profileRefs: snapshot.data.profiles.map(({ id, scope }) => ({ id, scope })),
        profiles: snapshot.data.profiles.map((profile) => profile.name),
        trackedFiles: Object.keys(snapshot.data.files).length,
      };
    },
    async profiles(repoId?: string) {
      const result = await profiles.list({ kind: 'global' });
      if (repoId) {
        const scope = { kind: 'repo' as const, repoId: repoIdSchema.parse(repoId) };
        await requireScope(scope);
        result.push(...(await profiles.list(scope)));
      }
      return result;
    },
    async saveProfile(value: unknown) {
      const input = saveSchema.parse(value);
      await requireScope(input.scope);
      return profiles.save(input.scope, validateProfile(input.profile), input.id);
    },
    async deleteProfile(value: unknown) {
      const saved = await findProfile(value);
      await profiles.remove(saved);
      return { deleted: saved.id };
    },
    async checkProfiles(value: unknown) {
      const refs = z.array(referenceSchema).min(1).parse(value);
      const saved = await Promise.all(refs.map(findProfile));
      return { profiles: saved.length, rules: mergeProfiles(saved).length };
    },
  };
}
export type Dashboard = ReturnType<typeof createDashboard>;
