import type { PostCommandResult } from '../adapters/post-create.js';
import type { SyncServices } from '../adapters/sync-services.js';
import { estimateRetainedBytes } from '../core/retained-size.js';
import { hashBytes, hashJson } from '../core/hash.js';
import type { SourceFile } from '../core/pull.js';
import { preparePullRun, runPull } from './pull.js';
import { preparePull } from './pull-setup.js';
import type { PullOptions } from './pull-setup.js';
import { preparePushRun, runPush } from './push.js';

export function createSyncCommand(services: SyncServices, version: string) {
  return (direction: 'pull' | 'push', options: PullOptions) =>
    sync(services, version, direction, options);
}

async function sync(
  services: SyncServices,
  version: string,
  direction: 'pull' | 'push',
  options: PullOptions,
) {
  const workspace = await services.store.findWorkspace(services.cwd);
  if ((direction === 'push' && workspace) || (direction === 'pull' && !workspace))
    return runPush(services, options, workspace);
  const { setup, io, postCommands } = await extraction(services, options, direction);
  const result = await runPull(setup, options, io, version);
  return { ...summary(result.plan, setup, result.status), postCommands };
}

export async function prepareSyncCommand(
  services: SyncServices,
  version: string,
  direction: 'pull' | 'push',
  options: PullOptions,
) {
  const workspace = await services.store.findWorkspace(services.cwd);
  if ((direction === 'push' && workspace) || (direction === 'pull' && !workspace))
    return preparePushRun(services, { ...options, dryRun: true }, workspace);
  const { setup, io, postCommands } = await extraction(
    services,
    { ...options, dryRun: true },
    direction,
  );
  const prepared = await preparePullRun(setup, io, version);
  return {
    plan: prepared.plan,
    repository: setup.repo,
    source: setup.repo,
    destination: { path: setup.destination, branch: null },
    bytes: estimateRetainedBytes({
      setup,
      plan: prepared.plan,
      files: prepared.files,
      workspace: prepared.workspace,
    }),
    redactions: prepared.plan.preview.filter(
      (match) => match.status === 'replaced' && match.kind === 'secret',
    ).length,
    postCreateCommands: setup.previous ? [] : (setup.config.postCreateCommands ?? []),
    result: { ...summary(prepared.plan, setup, 'written'), postCommands },
    apply: prepared.apply,
  };
}

function summary(
  plan: import('../core/pull.js').PullPlan,
  setup: import('./pull-setup.js').PullSetup,
  status: 'written' | 'dry-run' | 'cancelled',
) {
  return {
    status,
    workspace: setup.destination,
    workspaceId: setup.workspaceId,
    writes: plan.writes.map((file) => file.path),
    deletes: plan.deletes,
    replacements: plan.preview.filter((match) => match.status === 'replaced').length,
    skipped: plan.preview.filter((match) => match.status === 'skipped').length,
    warnings: plan.warnings,
    profileChanges: plan.profileChanges,
  };
}

async function extraction(
  services: SyncServices,
  options: PullOptions,
  direction: 'pull' | 'push',
) {
  if (
    options.from ||
    options.force ||
    options.skipConflicts ||
    options.newWorktree ||
    options.base ||
    options.path
  )
    throw new Error(
      '--from, conflict and new-worktree flags apply only when restoring workspace changes',
    );
  const setup = await preparePull(services, direction, options);
  if (!options.yes && !options.dryRun && !services.interactive)
    throw new Error(
      'Pass --yes to apply changes without an interactive terminal, or use --dry-run',
    );
  const concurrency = setup.config.concurrency ?? 16;

  const postCommands: PostCommandResult[] = [];
  const io: import('./pull.js').PullIO = {
    now: services.now,
    newId: services.newId,
    readSource: () => services.files.readSourceFiles(setup.repo.path, setup.paths, concurrency),
    readWorkspace: (paths) => services.files.readWorkspace(setup.destination, paths, concurrency),
    confirmProfiles: services.confirmProfiles,
    confirmPull: services.confirmPull,
    async save(plan, files, workspace) {
      const manifest = await services.store.sealManifest(plan);
      await services.writeWorkspace({
        root: setup.destination,
        plan,
        manifest,
        initGit: setup.config.initGit ?? true,
        expected: workspace.files,
        expectedManifest: setup.previous?.bytes,
        async afterSave() {
          await services.store.record(setup.repo, setup.destination, plan, manifest);
          if (setup.saveConfig) await services.store.saveConfig(setup.config);
        },
        async recheck() {
          await services.beforeApply?.();
          const source = await services.files.readSourceFiles(
            setup.repo.path,
            setup.paths,
            concurrency,
          );
          if (sourceHash(source.files) !== sourceHash(files))
            throw new Error('Source files changed while preparing the pull; retry');
          const current = await services.files.readWorkspace(
            setup.destination,
            Object.keys(workspace.files),
            concurrency,
          );
          if (workspaceHash(current) !== workspaceHash(workspace))
            throw new Error('Workspace files changed while preparing the pull; retry');
        },
      });
      if (!setup.previous && setup.config.postCreateCommands?.length)
        postCommands.push(
          ...(await services.runPostCreateCommands(
            setup.config.postCreateCommands,
            setup.destination,
          )),
        );
    },
  };
  return { setup, io, postCommands };
}

function sourceHash(files: SourceFile[]): string {
  return hashJson(
    files.map((file) => ({
      path: file.path,
      hash: file.bytes ? hashBytes(file.bytes) : null,
      executable: file.executable,
    })),
  );
}
function workspaceHash(workspace: { paths: string[]; files: Record<string, Uint8Array> }): string {
  return hashJson({
    paths: [...workspace.paths].sort(),
    files: Object.fromEntries(
      Object.entries(workspace.files).map(([path, bytes]) => [path, hashBytes(bytes)]),
    ),
  });
}
