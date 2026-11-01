import { rotateStoreKey } from '../adapters/key-rotation.js';
import type { KeyLocation } from '../adapters/key-storage.js';
import type { createStore } from '../adapters/store.js';
import type { createDashboardSync } from './dashboard-sync.js';

export function createDashboardSecurity(
  store: ReturnType<typeof createStore>,
  sync: ReturnType<typeof createDashboardSync>,
) {
  return {
    /** Runs while no sync can write: a reseal racing a pull could lose the pull's manifest. */
    rotateKey: () => sync.operations.exclusive(() => rotateStoreKey(store, sync.audit)),
    migrateKey: (target: KeyLocation) =>
      sync.operations.exclusive(async () => {
        await store.keys.migrate(target);
        await sync.audit.record({
          op: 'key-migrate',
          outcome: 'ok',
          detail: `Moved key to ${target}`,
        });
        return store.keyStatus();
      }),
  };
}
