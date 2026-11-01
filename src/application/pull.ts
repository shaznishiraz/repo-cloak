import { planPull, pullTargetPaths } from '../core/pull.js';
import type { PullInput, PullPlan, SourceFile } from '../core/pull.js';
import type { PullSetup } from './pull-setup.js';
import { instructionFiles } from '../core/agent-guidance.js';

export interface PullIO {
  readSource(): Promise<{ files: SourceFile[]; warnings: string[] }>;
  readWorkspace(paths: string[]): Promise<{ files: Record<string, Uint8Array>; paths: string[] }>;
  save(
    plan: PullPlan,
    files: SourceFile[],
    workspace: { files: Record<string, Uint8Array>; paths: string[] },
  ): Promise<void>;
  now(): string;
  newId(): string;
}
export async function preparePullRun(setup: PullSetup, io: PullIO, version: string) {
  const source = await io.readSource();
  if (!setup.previous && !source.files.some((file) => file.bytes))
    throw new Error('No selected source files remain after exclusions and safety checks');
  const paths = [
    ...new Set([
      ...(setup.exactSelection ? [] : Object.keys(setup.previous?.plain.files ?? {})),
      ...pullTargetPaths(source.files, setup.profiles, setup.previous),
      ...instructionFiles,
    ]),
  ];
  const workspace = await io.readWorkspace(paths);
  const input: PullInput = {
    guidance: true,
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
  if (setup.fromCommit) input.fromCommit = setup.fromCommit;
  const plan = planPull(input);
  plan.warnings.push(...source.warnings);
  return {
    plan,
    files: source.files,
    workspace,
    apply: () => io.save(plan, source.files, workspace),
  };
}
