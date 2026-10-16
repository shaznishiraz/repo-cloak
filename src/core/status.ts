import { hashBytes } from './hash.js';

/** Compare workspace bytes with the public manifest; no private metadata is needed. */
export function workspaceStatus(
  baseline: Readonly<Record<string, { hash: string }>>,
  files: Readonly<Record<string, Uint8Array>>,
) {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, bytes] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const previous = baseline[path];
    if (!Object.hasOwn(baseline, path)) added.push(path);
    else if (previous && hashBytes(bytes) !== previous.hash) modified.push(path);
  }
  for (const path of Object.keys(baseline).sort()) {
    if (!Object.hasOwn(files, path)) deleted.push(path);
  }
  return { added, modified, deleted };
}
