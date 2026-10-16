import { planPull, pullTargetPaths } from '../core/pull.js';
import type { PullInput, PullPlan, SourceFile } from '../core/pull.js';
import type { PullOptions, PullSetup } from './pull-setup.js';

export interface PullIO {
  readSource(): Promise<{ files: SourceFile[]; warnings: string[] }>;
  readWorkspace(paths: string[]): Promise<{ files: Record<string, Uint8Array>; paths: string[] }>;
  confirmProfiles(plan: PullPlan): Promise<boolean>;
  confirmPull(plan: PullPlan, destination: string): Promise<boolean>;
  save(
    plan: PullPlan,
    files: SourceFile[],
    workspace: { files: Record<string, Uint8Array>; paths: string[] },
  ): Promise<void>;
  now(): string;
  newId(): string;
}
export async function runPull(setup: PullSetup, options: PullOptions, io: PullIO, version: string) {
  const source = await io.readSource();
  if (!setup.previous && !source.files.some((file) => file.bytes))
    throw new Error('No selected source files remain after exclusions and safety checks');
  const paths = [
    ...new Set([
      ...Object.keys(setup.previous?.plain.files ?? {}),
      ...pullTargetPaths(source.files, setup.profiles, setup.previous),
    ]),
  ];
  const workspace = await io.readWorkspace(paths);
  const input: PullInput = {
    repo: setup.repo,
    profiles: setup.profiles,
    workspaceId: setup.workspaceId,
    files: source.files,
    workspace: workspace.files,
    workspacePaths: workspace.paths,
    selection: setup.selection,
    pullId: `p_${io.newId()}`,
    at: io.now(),
    version,
  };
  if (setup.previous) input.previous = setup.previous;
  const plan = planPull(input);
  plan.warnings.push(...source.warnings);
  if (options.dryRun) return { status: 'dry-run' as const, plan };
  if (!options.yes) {
    if (plan.profileChanges.length && !(await io.confirmProfiles(plan)))
      return { status: 'cancelled' as const, plan };
    if (!(await io.confirmPull(plan, setup.destination)))
      return { status: 'cancelled' as const, plan };
  }
  await io.save(plan, source.files, workspace);
  return { status: 'written' as const, plan };
}
