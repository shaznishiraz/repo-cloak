import type { SyncServices } from '../adapters/sync-services.js';
import { hashBytes, hashJson } from '../core/hash.js';
import type { SourceFile } from '../core/pull.js';
import { runPull } from './pull.js';
import { preparePull } from './pull-setup.js';
import type { PullOptions } from './pull-setup.js';
import { runPush } from './push.js';

export function createSyncCommand(services: SyncServices, version: string) {
  return async (direction: 'pull' | 'push', options: PullOptions) => {
    const workspace = await services.store.findWorkspace(services.cwd);
    if ((direction === 'push' && workspace) || (direction === 'pull' && !workspace))
      return runPush(services, options, workspace);
    if (options.from || options.force || options.skipConflicts)
      throw new Error(
        '--from, --force and --skip-conflicts apply only when restoring workspace changes',
      );
    const setup = await preparePull(services, direction, options);
    if (!options.yes && !options.dryRun && !services.interactive)
      throw new Error(
        'Pass --yes to apply changes without an interactive terminal, or use --dry-run',
      );
    const concurrency = setup.config.concurrency ?? 16;

    const result = await runPull(
      setup,
      options,
      {
        now: services.now,
        newId: services.newId,
        readSource: () => services.files.readSourceFiles(setup.repo.path, setup.paths, concurrency),
        readWorkspace: (paths) =>
          services.files.readWorkspace(setup.destination, paths, concurrency),
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
        },
      },
      version,
    );
    return {
      status: result.status,
      workspace: setup.destination,
      workspaceId: setup.workspaceId,
      writes: result.plan.writes.map((file) => file.path),
      deletes: result.plan.deletes,
      replacements: result.plan.preview.filter((match) => match.status === 'replaced').length,
      skipped: result.plan.preview.filter((match) => match.status === 'skipped').length,
      warnings: result.plan.warnings,
      profileChanges: result.plan.profileChanges,
    };
  };
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
