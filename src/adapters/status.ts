import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { StatusIO } from '../commands/status.js';
import { parseDocument } from '../core/schemas.js';
import { validateRelativePath } from '../core/paths.js';
import { checkDestinationPath, readWorkspace } from './files.js';
import { createStore } from './store.js';
import { createSyncStore } from './sync-store.js';

export function createStatusIO(cwd = process.cwd()): StatusIO {
  return {
    cwd,
    findWorkspace: createSyncStore(createStore()).findWorkspace,
    async readManifest(root) {
      await checkDestinationPath(root, '.repo-cloak/manifest.json');
      const path = join(root, '.repo-cloak', 'manifest.json');
      const manifest = parseDocument('manifest', JSON.parse(await readFile(path, 'utf8')), path);
      for (const file of Object.keys(manifest.files)) validateRelativePath(file);
      return manifest;
    },
    async readFiles(root, tracked) {
      const inventory = await readWorkspace(root, [], 16);
      return (await readWorkspace(root, [...new Set([...tracked, ...inventory.paths])], 16)).files;
    },
  };
}
