import { listSourcePaths } from '../adapters/source-paths.js';
import { deleteWorkspace } from '../adapters/workspace-delete.js';
import { createDashboardSettings } from './dashboard-settings.js';
import { documentSchema } from '../core/schemas.js';
import { version as packageVersion } from '../package.js';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { createStore } from '../adapters/store.js';
import { createSyncServices } from '../adapters/sync-services.js';
import { createUiOperations, OperationError } from '../adapters/ui-operations.js';
import type { OperationLimits, PreviewSummary } from '../adapters/ui-operations.js';
import { hashBytes, hashJson } from '../core/hash.js';
import { ConflictError } from '../core/errors.js';
import { validateRelativePath } from '../core/paths.js';
import { prepareSyncCommand } from './sync.js';
import type { PullOptions } from './pull-setup.js';

const repoIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
const profileRef = z.object({
  id: z.string().min(1),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('global') }),
    z.object({ kind: z.literal('repo'), repoId: repoIdSchema }),
  ]),
});
const selection = {
  profiles: z.array(profileRef).min(1).optional(),
  files: z.array(z.string().min(1)).optional(),
  commits: z.array(z.string().min(1)).optional(),
  working: z.boolean().optional(),
};
const inputSchema = z.discriminatedUnion('intent', [
  z
    .object({
      intent: z.literal('create'),
      repoId: repoIdSchema,
      worktree: z.string().min(1),
      destination: z.string().min(1).optional(),
      workspacesRoot: z.string().min(1).optional(),
      postCreateCommands: documentSchema.config.shape.postCreateCommands,
      saveDefaults: z.boolean().optional(),
      ...selection,
    })
    .strict(),
  z
    .object({
      intent: z.literal('refresh'),
      repoId: repoIdSchema,
      workspaceId: z.string().min(1),
      worktree: z.string().min(1),
      ...selection,
    })
    .strict(),
  z
    .object({
      intent: z.literal('restore'),
      repoId: repoIdSchema,
      workspaceId: z.string().min(1),
      worktree: z.string().min(1).optional(),
      newWorktree: z.string().min(1).optional(),
      base: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      policy: z.enum(['block', 'skip', 'force']).default('block'),
    })
    .strict(),
]);
const ackSchema = z
  .object({
    deletions: z.boolean().optional(),
    profiles: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();

export function createDashboardSync(
  store = createStore(),
  limits: OperationLimits = {},
  version = packageVersion,
) {
  const operations = createUiOperations(limits);
  const services = createSyncServices(process.cwd(), store);
  services.interactive = false;
  async function registered(repoId: string) {
    const repo = await services.store.readRepo(repoIdSchema.parse(repoId));
    if (!repo) throw new OperationError('validation', 'Repository is not registered');
    return repo;
  }
  async function worktrees(repoId: string) {
    const repo = await registered(repoId);
    const state = await services.git.repoState(repo.path);
    if (state.repoId !== repoId)
      throw new OperationError('validation', 'Repository identity changed');
    return services.git.worktrees(repo.path);
  }
  async function worktree(repoId: string, path: string) {
    const canonical = await services.files.canonicalPath(path);
    const trees = await worktrees(repoId);
    const found = (
      await Promise.all(
        trees.map(async (tree) => ({
          ...tree,
          path: await services.files.canonicalPath(tree.path),
        })),
      )
    ).find((tree) => tree.path === canonical);
    if (!found || (await services.git.repoState(canonical)).repoId !== repoId)
      throw new OperationError('validation', 'Select a worktree belonging to this repository');
    return canonical;
  }
  async function workspace(repoId: string, id: string) {
    const repo = await registered(repoId);
    const link = Object.hasOwn(repo.workspaces, id) ? repo.workspaces[id] : undefined;
    if (!link) throw new OperationError('validation', 'Workspace is not registered');
    const snapshot = await services.store.readSnapshot(link.path);
    if (!snapshot || snapshot.plain.source.repoId !== repoId || snapshot.plain.workspaceId !== id)
      throw new OperationError(
        'validation',
        'Workspace manifest is missing or belongs to another workspace',
      );
    return { path: await services.files.canonicalPath(link.path), snapshot };
  }
  async function prepare(value: unknown) {
    const input = inputSchema.parse(value);
    const repo = await registered(input.repoId);
    const link =
      input.intent === 'create' ? undefined : await workspace(input.repoId, input.workspaceId);
    const selected = input.worktree ? await worktree(input.repoId, input.worktree) : undefined;
    if (input.intent === 'restore' && input.newWorktree && input.worktree)
      throw new OperationError('validation', 'Choose an existing worktree or a new worktree');
    const cwd = input.intent === 'create' ? selected : link?.path;
    if (!cwd) throw new OperationError('validation', 'Select a worktree or workspace');
    const local = { ...services, cwd };
    const options: PullOptions = {};
    if (input.intent !== 'restore') {
      if (input.profiles) {
        for (const ref of input.profiles)
          if (ref.scope.kind === 'repo' && ref.scope.repoId !== input.repoId)
            throw new OperationError('validation', 'Profile belongs to another repository');
        // IDs plus scope make same-name profiles unambiguous.
        options.profiles = input.profiles.map((ref) => `${ref.scope.kind}:${ref.id}`);
      }
      if (input.files)
        options.files = input.files.map((path) =>
          resolve(selected ?? cwd, path === '.' ? '.' : validateRelativePath(path)),
        );
      if (input.commits !== undefined) options.commits = input.commits;
      if (input.working !== undefined) options.working = input.working;
      if (input.intent === 'create') {
        options.newWorkspace = true;
        if (input.workspacesRoot)
          options.workspacesRoot = await createDashboardSettings(store).validateRoot(
            input.workspacesRoot,
          );
        if (input.postCreateCommands) options.postCreateCommands = input.postCreateCommands;
        if (input.saveDefaults) options.saveDefaults = true;
        if (input.destination) options.to = resolve(selected ?? cwd, input.destination);
      } else if (selected) options.worktree = selected;
    } else {
      if (selected) options.worktree = selected;
      if (input.newWorktree !== undefined) options.newWorktree = input.newWorktree;
      if (input.base !== undefined) options.base = input.base;
      if (input.path !== undefined) options.path = input.path;
      // Default previews collect conflicts without permitting partial writes.
      options.skipConflicts = input.policy !== 'force';
      options.force = input.policy === 'force';
    }
    const direction =
      input.intent === 'create' ? 'push' : input.intent === 'refresh' ? 'pull' : 'push';
    const initialState = await services.git.repoState(selected ?? repo.path);
    let prepared: Awaited<ReturnType<typeof prepareSyncCommand>>;
    let forceConflicts: string[] = [];
    if (input.intent === 'restore' && input.policy === 'force') {
      const conflicts = await prepareSyncCommand(local, version, direction, {
        ...options,
        force: false,
        skipConflicts: true,
      });
      if ('conflicts' in conflicts.plan) forceConflicts = conflicts.plan.conflicts;
    }
    try {
      prepared = await prepareSyncCommand(local, version, direction, options);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const summary: PreviewSummary = {
        intent: input.intent,
        source: { path: selected ?? repo.path, branch: initialState.branch },
        destination: { path: link?.path ?? input.worktree ?? '', branch: null },
        writes: [],
        deletes: [],
        warnings: [error.message],
        conflicts: [error.message],
        profileChanges: [],
        replacements: 0,
        canApply: false,
        forced: false,
        redactions: 0,
        postCreateCommands: [],
      };
      return {
        summary,
        bytes: Buffer.byteLength(JSON.stringify(summary)),
        apply: async () => {
          throw new OperationError('conflict', error.message);
        },
      };
    }
    const sourcePath = input.intent === 'restore' ? prepared.repository.path : prepared.source.path;
    const workspacePath = prepared.result.workspace;
    // Bind approval to identities, selected profiles, inventory and original destination.
    // Content baselines are also rechecked by the shared writers under their locks.
    const capture = async (underWriter = false) => {
      const state = await services.git.repoState(sourcePath);
      const sourceInventory = await services.files.readWorkspace(sourcePath, [], 16);
      const workspaceInventory = await services.files.readWorkspace(workspacePath, [], 16);
      const snapshot = await services.store.readSnapshot(workspacePath);
      const refs = input.intent === 'restore' ? [] : prepared.plan.data.profiles;
      const profileStates = await Promise.all(
        refs.map(async (ref) => {
          const saved = (await services.profiles.list(ref.scope)).find(
            (profile) => profile.id === ref.id,
          );
          if (!saved || hashJson(saved.profile) !== ref.hash)
            throw new OperationError(
              'stale',
              'Profile changed during preview; create a new preview',
            );
          return saved;
        }),
      );
      const destination = prepared.destination.path;
      const present = await services.files.exists(destination);
      return hashJson({
        state,
        sourcePaths: sourceInventory.paths.sort(),
        workspacePaths: workspaceInventory.paths.sort(),
        manifest: snapshot ? hashBytes(snapshot.bytes) : null,
        profiles: profileStates,
        config: await services.store.readConfig(),
        commits:
          input.intent === 'restore'
            ? input.base
              ? await services.git.resolveCommit(sourcePath, input.base)
              : null
            : await Promise.all(
                (input.commits ?? []).map((ref) => services.git.resolveCommit(sourcePath, ref)),
              ),
        destination: await services.files.canonicalPath(destination),
        exists: underWriter && input.intent === 'create' && !destinationExisted ? false : present,
        // A destination may not become a different repo while a preview is open.
        parentRepo: await services.git.findRepo(await existingParent(destination)),
      });
    };
    const destinationExisted = await services.files.exists(prepared.destination.path);
    const fingerprint = await capture();
    if (hashJson(await services.git.repoState(sourcePath)) !== hashJson(prepared.repository))
      throw new OperationError('stale', 'Worktree changed during preview; create a new preview');
    const recheck = async (underWriter = false) => {
      try {
        if ((await capture(underWriter)) !== fingerprint) throw new Error('Inputs changed');
        if (link) await workspace(input.repoId, input.intent === 'create' ? '' : input.workspaceId);
      } catch (cause) {
        throw new OperationError(
          'stale',
          `Preview is stale; create a new preview (${cause instanceof Error ? cause.message : 'inputs changed'})`,
        );
      }
    };
    local.beforeApply = () => recheck(true);
    const conflicts = 'conflicts' in prepared.plan ? prepared.plan.conflicts : [];
    const summary: PreviewSummary = {
      intent: input.intent,
      source: { path: prepared.source.path, branch: prepared.source.branch },
      destination: { path: prepared.destination.path, branch: prepared.destination.branch },
      writes: prepared.result.writes,
      deletes: prepared.result.deletes,
      warnings: prepared.result.warnings,
      conflicts: [...conflicts, ...forceConflicts],
      profileChanges: prepared.result.profileChanges,
      replacements: prepared.result.replacements,
      canApply: !(input.intent === 'restore' && input.policy === 'block' && conflicts.length),
      forced: input.intent === 'restore' && input.policy === 'force',
      redactions: prepared.redactions,
      postCreateCommands: prepared.postCreateCommands,
    };
    return {
      summary,
      bytes: prepared.bytes,
      async apply() {
        await recheck();
        await prepared.apply();
        return prepared.result;
      },
    };
  }
  async function existingParent(path: string) {
    let parent = dirname(path);
    while (!(await services.files.exists(parent))) parent = dirname(parent);
    return parent;
  }
  async function selectionProfiles(repoId: string, refs: unknown) {
    const references = z.array(profileRef).parse(refs);
    const available = await Promise.all(
      references.map(async (ref) => {
        if (ref.scope.kind === 'repo' && ref.scope.repoId !== repoId)
          throw new OperationError('validation', 'Profile belongs to another repository');
        const found = (await services.profiles.list(ref.scope)).find(
          (profile) => profile.id === ref.id,
        );
        if (!found) throw new OperationError('validation', 'Profile no longer exists');
        return found.profile;
      }),
    );
    return available;
  }
  async function inventory(
    repoId: string,
    path: string,
    refs: unknown = [],
    respectGitIgnore = true,
  ) {
    const root = await worktree(repoId, path);
    const available = await selectionProfiles(repoId, refs);
    return { files: await listSourcePaths(root, available, z.boolean().parse(respectGitIgnore)) };
  }
  async function selectionContext(repoId: string, path: string, refs: unknown = []) {
    const root = await worktree(repoId, path);
    const available = await selectionProfiles(repoId, refs);
    const [working, commits] = await Promise.all([
      services.git.workingFiles(root),
      services.git.recentCommits(root),
    ]);
    const paths = services.files.filterPaths(working, available).sort();
    return {
      working: paths.slice(0, 200),
      workingCount: paths.length,
      workingNext: paths.length > 200 ? 200 : null,
      commits,
    };
  }
  return {
    worktrees,
    deleteWorkspace: (repoId: string, id: string, path: string) =>
      operations.exclusive(() => deleteWorkspace(store, repoId, id, path)),
    inventory,
    selectionContext,
    async selection(
      repoId: string,
      path: string,
      offset = 0,
      query = '',
      refs: unknown = [],
      directory?: string,
    ) {
      const root = await worktree(repoId, path);
      const available = await selectionProfiles(repoId, refs);
      const paths = (await listSourcePaths(root, available)).filter((path) =>
        path.toLowerCase().includes(query.toLowerCase()),
      );
      const start = z.number().int().min(0).parse(offset);
      const prefix = directory ? `${validateRelativePath(directory)}/` : '';
      const folders = new Set<string>();
      const visible =
        directory === undefined
          ? paths
          : paths.filter((path) => {
              if (!path.startsWith(prefix)) return false;
              const rest = path.slice(prefix.length);
              const slash = rest.indexOf('/');
              if (slash < 0) return true;
              folders.add(prefix + rest.slice(0, slash));
              return false;
            });
      const working = services.files
        .filterPaths(await services.git.workingFiles(root), available)
        .sort();
      return {
        directories: [...folders].sort(),
        directory: directory ?? '',
        files: visible.slice(start, start + 200),
        next: start + 200 < visible.length ? start + 200 : null,
        commits: await services.git.recentCommits(root),
        working: working.slice(start, start + 200),
        workingCount: working.length,
        workingNext: start + 200 < working.length ? start + 200 : null,
      };
    },
    preview: (value: unknown) => operations.preview(() => prepare(value)),
    apply: (id: string, value: unknown) => operations.apply(id, ackSchema.parse(value)),
    status: operations.status,
    cancel: operations.cancel,
    wait: operations.wait,
    close: operations.close,
  };
}
