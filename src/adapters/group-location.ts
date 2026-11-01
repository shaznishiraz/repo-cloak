import { dirname, join } from 'node:path';
import { exists } from './files.js';
import { canonicalPath } from './locations.js';

/** Standalone creation must not adopt an existing group's folder or its children. */
export async function outsideGroupFolders(path: string): Promise<string> {
  let outside = await canonicalPath(path);
  for (let current = outside; ; current = dirname(current)) {
    if (await exists(join(current, '.repo-cloak/group.json'))) outside = dirname(current);
    if (dirname(current) === current) return outside;
  }
}
