import { dirname } from 'node:path';
import { createSyncServices } from '../adapters/sync-services.js';
import { createStore } from '../adapters/store.js';
import { absoluteFolder } from '../adapters/folders.js';
import { createAuditStore } from '../adapters/audit-store.js';
import { documentSchema } from '../core/schemas.js';

const settingsSchema = documentSchema.config
  .pick({ workspacesRoot: true, postCreateCommands: true })
  .strict();
export function createDashboardSettings(store = createStore(), audit = createAuditStore(store)) {
  const services = createSyncServices(process.cwd(), store);
  async function validateRoot(value: string) {
    const root = await services.files.canonicalPath(absoluteFolder(value));
    let ancestor = root;
    while (!(await services.files.exists(ancestor))) ancestor = dirname(ancestor);
    if ((await services.git.findRepo(ancestor)) || (await services.store.findWorkspace(ancestor)))
      throw new Error(
        'The cloak workspaces folder must be outside Git repositories and cloak workspaces',
      );
    return root;
  }
  return {
    validateRoot,
    async read() {
      const config = await services.store.readConfig();
      return {
        workspacesRoot: config.workspacesRoot ?? '',
        postCreateCommands: config.postCreateCommands ?? [],
      };
    },
    async save(value: unknown) {
      const input = settingsSchema.parse(value);
      const config = await services.store.readConfig();
      const root = input.workspacesRoot
        ? await validateRoot(input.workspacesRoot)
        : config.workspacesRoot;
      const saved = {
        ...config,
        ...(root ? { workspacesRoot: root } : {}),
        ...(input.postCreateCommands ? { postCreateCommands: input.postCreateCommands } : {}),
      };
      await services.store.saveConfig(saved);
      const changed = (['workspacesRoot', 'postCreateCommands'] as const).filter(
        (field) => JSON.stringify(saved[field]) !== JSON.stringify(config[field]),
      );
      // Names only: post-create commands can contain anything the user typed.
      if (changed.length)
        await audit.record({
          op: 'settings',
          outcome: 'ok',
          detail: `Changed ${changed.join(', ')}`,
        });
      return {
        workspacesRoot: saved.workspacesRoot ?? '',
        postCreateCommands: saved.postCreateCommands ?? [],
      };
    },
  };
}
