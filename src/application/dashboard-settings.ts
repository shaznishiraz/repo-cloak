import { dirname } from 'node:path';
import { createSyncServices } from '../adapters/sync-services.js';
import { createStore } from '../adapters/store.js';
import { absoluteFolder } from '../adapters/folders.js';
import { createAuditStore } from '../adapters/audit-store.js';
import { documentSchema } from '../core/schemas.js';
import { effectiveSecurity } from '../core/policy.js';
import { OperationError } from '../adapters/ui-operations.js';

const settingsSchema = documentSchema.config
  .pick({ workspacesRoot: true, postCreateCommands: true })
  .strict();
const securitySchema = documentSchema.config
  .pick({
    keyStorage: true,
    auditRetentionDays: true,
    allowExclusionOverride: true,
    autoLockMinutes: true,
  })
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
  async function effective() {
    return effectiveSecurity(await services.store.readConfig(), await store.policy());
  }
  async function security() {
    const [config, values, policy] = await Promise.all([
      services.store.readConfig(),
      effective(),
      store.policy(),
    ]);
    return {
      ...values,
      keyStorage: config.keyStorage ?? ('auto' as const),
      policy:
        policy.status === 'active'
          ? {
              status: policy.status,
              path: policy.path,
              signed: policy.signed,
              ...(policy.userWritable
                ? {
                    message:
                      'This account can edit the policy file, so it is not enforced by the OS',
                  }
                : {}),
            }
          : policy.status === 'invalid'
            ? { status: policy.status, path: policy.path, signed: false, message: policy.message }
            : { status: policy.status, path: null, signed: false },
    };
  }
  return {
    effective,
    security,
    /** Rejects a change to a policy-locked field rather than quietly ignoring it. */
    async saveSecurity(value: unknown) {
      const input = securitySchema.parse(value);
      const current = await effective();
      for (const field of [
        'auditRetentionDays',
        'allowExclusionOverride',
        'autoLockMinutes',
      ] as const)
        if (field in input && current.locked.includes(field) && input[field] !== current[field])
          throw new OperationError('validation', `${field} is locked by machine policy`);
      const config = await services.store.readConfig();
      await services.store.saveConfig({ ...config, ...input });
      await audit.record({
        op: 'settings',
        outcome: 'ok',
        detail: `Changed ${Object.keys(input).join(', ') || 'nothing'}`,
      });
      return security();
    },
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
