import { basename } from 'node:path';
import { z } from 'zod';
import { createStore } from '../adapters/store.js';
import { createSyncStore } from '../adapters/sync-store.js';
import { createProfileStore } from '../adapters/profiles.js';
import { createStatusIO } from '../adapters/status.js';
import { findRepo, repoState } from '../adapters/git.js';
import { exists } from '../adapters/files.js';
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

export function createDashboard(store = createStore(), cwd = process.cwd()) {
  const syncStore = createSyncStore(store);
  const profiles = createProfileStore(store);
  async function requireScope(scope: ProfileScope) {
    if (scope.kind === 'repo' && !(await syncStore.readRepo(scope.repoId)))
      throw new Error('Repository is not registered');
  }
  async function findProfile(value: unknown) {
    const ref = referenceSchema.parse(value);
    await requireScope(ref.scope);
    const saved = (await profiles.list(ref.scope)).find((profile) => profile.id === ref.id);
    if (!saved) throw new Error('Profile no longer exists');
    return saved;
  }
  return {
    async context() {
      const workspace = await syncStore.findWorkspace(cwd);
      if (workspace) {
        const snapshot = await syncStore.readSnapshot(workspace);
        return { repoId: snapshot?.plain.source.repoId, workspaceId: snapshot?.plain.workspaceId };
      }
      const repo = await findRepo(cwd);
      if (repo) await syncStore.registerRepo(await repoState(repo.topLevel));
      return { repoId: repo?.repoId };
    },
    async overview() {
      const repos = [];
      for (const id of await store.listDirectories('repos')) {
        if (!repoIdSchema.safeParse(id).success) continue;
        const repo = await syncStore.readRepo(id);
        if (!repo) continue;
        const workspaces = await Promise.all(
          Object.entries(repo.workspaces).map(async ([id, workspace]) => ({
            id,
            name: basename(workspace.path),
            path: workspace.path,
            lastUsedAt: workspace.lastUsedAt,
            lastProfiles: workspace.lastProfiles,
            missing: !(await exists(workspace.path)),
          })),
        );
        repos.push({
          id,
          name: basename(repo.path),
          path: repo.path,
          workspaces: workspaces.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)),
        });
      }
      return repos.sort((a, b) => a.name.localeCompare(b.name));
    },
    async workspace(repoId: string, id: string) {
      const repo = await syncStore.readRepo(repoIdSchema.parse(repoId));
      const workspace =
        repo && Object.hasOwn(repo.workspaces, id) ? repo.workspaces[id] : undefined;
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
        profiles: snapshot.data.profiles.map((profile) => profile.name),
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
