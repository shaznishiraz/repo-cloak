import { listSourcePaths } from '../adapters/source-paths.js';
import { deleteWorkspace } from '../adapters/workspace-delete.js';
import { createDashboardSettings } from './dashboard-settings.js';
import { documentSchema } from '../core/schemas.js';
import { version as packageVersion } from '../package.js';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import pLimit from 'p-limit';
import { createAuditStore } from '../adapters/audit-store.js';
import { maxAuditFiles } from '../core/audit.js';
import { effectiveSecurity } from '../core/policy.js';
import { z } from 'zod';
import { createStore } from '../adapters/store.js';
import { createSyncServices } from '../adapters/sync-services.js';
import { createUiOperations, OperationError } from '../adapters/ui-operations.js';
import type {
  OperationLimits,
  PreviewSummary,
  PreparedOperation,
} from '../adapters/ui-operations.js';
import { hashBytes, hashJson } from '../core/hash.js';
import { ConflictError } from '../core/errors.js';
import { checkPathCollisions, validateRelativePath } from '../core/paths.js';
import { prepareSync } from './sync.js';
import type { SyncOptions } from './pull-setup.js';
import { createCommitDiff } from '../adapters/commit-diff.js';
import { compilePatterns, patternProblem } from '../core/patterns.js';
import { createReplacer } from '../core/replacer.js';
import { readLimitedSourceFiles } from '../adapters/agent-files.js';

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
      name: z.string().trim().min(1).max(80).optional(),
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

const auditOp = { create: 'create', refresh: 'pull', restore: 'push' } as const;

export function createDashboardSync(
  store = createStore(),
  limits: OperationLimits = {},
  version = packageVersion,
) {
  const operations = createUiOperations(limits);
  const services = createSyncServices(process.cwd(), store);
  const audit = createAuditStore(store, {
    retentionDays: async () =>
      effectiveSecurity(await services.store.readConfig(), await store.policy()).auditRetentionDays,
  });
  /** Paths and content hashes only; a file that cannot be read is logged without a hash. */
  async function auditFiles(root: string, paths: string[]) {
    const limit = pLimit(16);
    return Promise.all(
      paths.slice(0, maxAuditFiles).map((path) =>
        limit(async () => {
          try {
            await services.files.checkDestinationPath(root, path);
            return { path, hash: hashBytes(await readFile(join(root, path))) };
          } catch {
            return { path };
          }
        }),
      ),
    ).then((files) => [...files, ...paths.slice(maxAuditFiles).map((path) => ({ path }))]);
  }
  async function auditProfiles(workspacePath: string) {
    const snapshot = await services.store.readSnapshot(workspacePath).catch(() => undefined);
    return (snapshot?.data.profiles ?? []).map(({ id, hash }) => ({ id, hash }));
  }
  async function registered(repoId: string) {
    const repo = await services.store.readRepo(repoIdSchema.parse(repoId));
    if (!repo || repo.hidden)
      throw new OperationError('validation', 'Repository is not registered');
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
  async function prepare(
    value: unknown,
    internal?: {
      exactFiles?: boolean;
      requestId?: string;
      requestPaths?: string[];
      maxFileBytes?: number;
    },
  ): Promise<PreparedOperation> {
    const input = inputSchema.parse(value);
    const repo = await registered(input.repoId);
    const link =
      input.intent === 'create' ? undefined : await workspace(input.repoId, input.workspaceId);
    const selected = input.worktree ? await worktree(input.repoId, input.worktree) : undefined;
    if (input.intent === 'restore' && input.newWorktree && input.worktree)
      throw new OperationError('validation', 'Choose an existing worktree or a new worktree');
    const cwd = input.intent === 'create' ? selected : link?.path;
    if (!cwd) throw new OperationError('validation', 'Select a worktree or workspace');
    const maxFileBytes = internal?.maxFileBytes;
    const local = {
      ...services,
      cwd,
      ...(maxFileBytes
        ? {
            files: {
              ...services.files,
              readSourceFiles: (root: string, paths: string[], concurrency: number) =>
                readLimitedSourceFiles(root, paths, maxFileBytes, concurrency),
            },
          }
        : {}),
    };
    const options: SyncOptions = {};
    if (internal?.exactFiles) options.exactFiles = true;
    if (input.intent === 'create' && input.name) {
      if (input.destination)
        throw new Error('Choose a workspace name or an exact destination, not both');
      options.name = input.name;
    }
    if (input.intent !== 'restore') {
      if (input.profiles) {
        for (const ref of input.profiles)
          if (ref.scope.kind === 'repo' && ref.scope.repoId !== input.repoId)
            throw new OperationError('validation', 'Profile belongs to another repository');
        // IDs plus scope make same-name profiles unambiguous.
        options.profiles = input.profiles.map((ref) => `${ref.scope.kind}:${ref.id}`);
      }
      if (input.files)
        options.files = internal?.exactFiles
          ? input.files
          : input.files.map((path) =>
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
    let prepared: Awaited<ReturnType<typeof prepareSync>>;
    let forceConflicts: string[] = [];
    if (input.intent === 'restore' && input.policy === 'force') {
      const conflicts = await prepareSync(local, version, direction, {
        ...options,
        force: false,
        skipConflicts: true,
      });
      if ('conflicts' in conflicts.plan) forceConflicts = conflicts.plan.conflicts;
    }
    try {
      prepared = await prepareSync(local, version, direction, options);
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
    if (internal?.requestId) {
      const pull = prepared.plan.plain.pulls.at(-1);
      if (!pull || input.intent !== 'refresh') throw new Error('Invalid request pull');
      pull.extensions = {
        agentRequestId: internal.requestId,
        agentRequestPaths: internal.requestPaths ?? [],
      };
    }
    const workspacePath = prepared.result.workspace;
    // Bind approval to identities, selected profiles, inventory and original destination.
    // Content baselines are also rechecked by the shared writers under their locks.
    const capture = async (underWriter = false) => {
      await registered(input.repoId);
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
        repoExclusions: (await services.store.readRepo(input.repoId))?.exclude ?? [],
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
      async recheck() {
        await recheck();
        await prepared.recheck();
      },
      async apply() {
        await recheck();
        const workspace = {
          repoId: input.repoId,
          id: prepared.result.workspaceId,
          name: basename(prepared.result.workspace),
        };
        const op = auditOp[input.intent];
        try {
          await prepared.apply();
        } catch (error) {
          await audit.record({ op, outcome: 'failed', workspace, detail: 'Operation failed' });
          throw error;
        }
        await audit.record({
          op,
          outcome: 'ok',
          workspace,
          files: [
            ...(await auditFiles(prepared.destination.path, prepared.result.writes)),
            ...prepared.result.deletes.map((path) => ({ path })),
          ],
          profiles: await auditProfiles(prepared.result.workspace),
        });
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
    const repo = await registered(repoId);
    return {
      files: await listSourcePaths(
        root,
        available,
        z.boolean().parse(respectGitIgnore),
        repo.exclude ?? [],
      ),
    };
  }
  async function selectionContext(repoId: string, path: string, refs: unknown = []) {
    const root = await worktree(repoId, path);
    const available = await selectionProfiles(repoId, refs);
    const repo = await registered(repoId);
    const [working, commits] = await Promise.all([
      services.git.workingFiles(root),
      services.git.recentCommits(root),
    ]);
    const paths = services.files.filterPaths(working, available, repo.exclude ?? []).sort();
    return {
      working: paths.slice(0, 200),
      workingCount: paths.length,
      workingNext: paths.length > 200 ? 200 : null,
      commits,
    };
  }
  async function saveExclusions(repoId: string, value: unknown) {
    await registered(repoId);
    const input = z
      .object({ patterns: z.array(z.string().max(500)).max(200) })
      .strict()
      .parse(value);
    const patterns = [...new Set(input.patterns)];
    for (const pattern of patterns) {
      const problem = patternProblem(pattern);
      if (problem) throw new OperationError('validation', `${pattern}: ${problem}`);
    }
    const policy = await store.policy();
    const locked = policy.status === 'active' ? (policy.policy.lockedExclusions ?? []) : [];
    await services.store.saveRepoExclusions(
      repoId,
      patterns.filter((pattern) => !locked.includes(pattern)),
    );
    await audit.record({
      op: 'settings',
      outcome: 'ok',
      detail: `Repository exclusions changed for ${repoId} (${patterns.length} patterns)`,
    });
    return { patterns };
  }
  async function commitPage(root: string, offset: unknown = 0, ref?: string) {
    const start = z.coerce.number().int().min(0).max(100000).parse(offset);
    if (ref !== undefined) {
      const value = z.string().trim().min(1).max(500).parse(ref);
      const id = await services.git.resolveCommit(root, value);
      const subject = (
        await services.git.runGit(root, ['log', '-1', '--format=%s', id, '--'])
      ).trim();
      return [{ id, subject }];
    }
    return services.git.recentCommits(root, start);
  }
  async function exportContext(repoId: string, id: string) {
    const { snapshot } = await workspace(repoId, id);
    const repo = await registered(repoId);
    if (snapshot.plain.source.repoId !== repo.repoId)
      throw new OperationError('validation', 'Workspace belongs to another source repository');
    const root = await worktree(repoId, repo.path);
    return { root, snapshot };
  }
  return {
    audit,
    operations,
    prepareOperation: prepare,
    workspaceTarget: workspace,
    worktrees,
    deleteWorkspace: (repoId: string, id: string, path: string) =>
      operations.exclusive(async () => {
        const workspace = { repoId, id, name: basename(path) };
        try {
          const result = await deleteWorkspace(store, repoId, id, path);
          await audit.record({ op: 'delete', outcome: 'ok', workspace });
          return result;
        } catch (error) {
          await audit.record({
            op: 'delete',
            outcome: 'failed',
            workspace,
            detail: 'Delete failed',
          });
          throw error;
        }
      }),
    inventory,
    selectionContext,
    async exclusions(repoId: string) {
      const repo = await registered(repoId);
      return { patterns: repo.exclude ?? [] };
    },
    saveExclusions: (repoId: string, value: unknown) =>
      operations.exclusive(() => saveExclusions(repoId, value)),
    async commits(repoId: string, path: string, offset: unknown = 0, ref?: string) {
      return commitPage(await worktree(repoId, path), offset, ref);
    },
    async exportCommits(repoId: string, id: string, offset: unknown = 0, ref?: string) {
      const { root } = await exportContext(repoId, id);
      return commitPage(root, offset, ref);
    },
    async exportFiles(repoId: string, id: string, value: unknown) {
      const { root, snapshot } = await exportContext(repoId, id);
      const repo = await registered(repoId);
      const input = z
        .object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/) })
        .strict()
        .parse(value);
      const commit = await services.git.resolveCommit(root, input.commit);
      if (commit !== input.commit) throw new OperationError('validation', 'Invalid source commit');
      const paths = [...new Set(await services.git.commitFiles(root, commit))].sort();
      if (paths.length > 5000)
        throw new OperationError('limit', 'This commit changes more than 5,000 files');
      const [stats, isExcluded] = await Promise.all([
        services.git.commitFileStats(root, commit),
        Promise.resolve(compilePatterns(repo.exclude ?? [])),
      ]);
      const replacer = createReplacer(snapshot.data.rules);
      let ledger = structuredClone(snapshot.data.ledger);
      const files = paths.map((path, index) => {
        const result = replacer.anonymize(path, { file: path, scope: 'paths' }, ledger);
        ledger = result.ledger;
        const stat = stats.get(path);
        return {
          index,
          path: result.text,
          added: stat?.added ?? null,
          removed: stat?.removed ?? null,
          excluded: isExcluded(path),
        };
      });
      checkPathCollisions(
        files.map((file, index) => ({ original: paths[index] ?? '', anonymized: file.path })),
        false,
      );
      return { files };
    },
    async exportDiff(repoId: string, id: string, value: unknown) {
      const { root, snapshot } = await exportContext(repoId, id);
      const repo = await registered(repoId);
      const isExcluded = compilePatterns(repo.exclude ?? []);
      const security = effectiveSecurity(await services.store.readConfig(), await store.policy());
      const isLocked = compilePatterns(security.lockedExclusions);
      const input = z
        .object({
          commit: z.string().regex(/^[a-f0-9]{40,64}$/),
          indexes: z.array(z.number().int().min(0).max(4999)).max(100),
          includeExcluded: z.boolean().default(false),
        })
        .strict()
        .parse(value);
      const commit = await services.git.resolveCommit(root, input.commit);
      if (commit !== input.commit) throw new OperationError('validation', 'Invalid source commit');
      const changed = [...new Set(await services.git.commitFiles(root, commit))].sort();
      const indexes = [...new Set(input.indexes)];
      const paths = indexes.map((index) => {
        const path = changed[index];
        if (!path) throw new OperationError('validation', 'A selected file is not in this commit');
        if (isLocked(path))
          throw new OperationError('validation', 'Machine policy excludes this file');
        if (isExcluded(path) && !(input.includeExcluded && security.allowExclusionOverride))
          throw new OperationError(
            'validation',
            'Enable the repository-exclusion override to export this file',
          );
        return path;
      });
      const parentLine = (
        await services.git.runGit(root, ['rev-list', '--parents', '-n', '1', commit])
      )
        .trim()
        .split(/\s+/);
      const parent = parentLine[1];
      const [before, after] = await Promise.all([
        parent
          ? services.worktree.readCommit(root, parent, paths, 4).then((result) => result.files)
          : Promise.resolve(paths.map((path) => ({ path, binary: false, executable: false }))),
        services.worktree.readCommit(root, commit, paths, 4).then((result) => result.files),
      ]);
      const result = await createCommitDiff({
        root,
        before,
        after,
        paths,
        rules: snapshot.data.rules,
        ledger: snapshot.data.ledger,
      });
      return result;
    },
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
      const repo = await registered(repoId);
      const isExcluded = compilePatterns(repo.exclude ?? []);
      const paths = (await listSourcePaths(root, available, true, repo.exclude ?? [])).filter(
        (path) => path.toLowerCase().includes(query.toLowerCase()) && !isExcluded(path),
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
        .filterPaths(await services.git.workingFiles(root), available, repo.exclude ?? [])
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
