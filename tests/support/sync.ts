import { prepareSync } from '../../src/application/sync.js';
import type { SyncOptions } from '../../src/application/pull-setup.js';
import type { SyncServices } from '../../src/adapters/sync-services.js';

/** Drive the shared preview/apply boundary in integration fixtures. No terminal UI. */
export function createTestSync(services: SyncServices, version: string) {
  return async (direction: 'pull' | 'push', value: SyncOptions & { preview?: boolean }) => {
    const { preview, ...options } = value;
    const prepared = await prepareSync(services, version, direction, options);
    if (preview) return { ...prepared.result, status: 'preview' as const };
    await prepared.apply();
    return prepared.result;
  };
}
