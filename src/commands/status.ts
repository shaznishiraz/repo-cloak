import { workspaceStatus } from '../core/status.js';
import type { PlainManifest } from '../core/manifest.js';

export type StatusIO = {
  cwd: string;
  findWorkspace(cwd: string): Promise<string | undefined>;
  readManifest(root: string): Promise<PlainManifest>;
  readFiles(root: string, tracked: string[]): Promise<Record<string, Uint8Array>>;
};

export async function runStatus(io: StatusIO) {
  const root = await io.findWorkspace(io.cwd);
  if (!root) throw new Error('Run status inside a repo-cloak workspace');
  const manifest = await io.readManifest(root);
  const files = await io.readFiles(root, Object.keys(manifest.files));
  return { workspaceId: manifest.workspaceId, ...workspaceStatus(manifest.files, files) };
}
