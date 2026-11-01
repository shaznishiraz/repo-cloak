import type { Keychain } from '../../src/adapters/keychain.js';

export function createFakeKeychain(available = true) {
  const items = new Map<string, Buffer>();
  const state = { available, failReads: false, calls: 0 };
  const keychain: Keychain = {
    label: 'Fake Keychain',
    available: async () => state.available,
    async get(account) {
      state.calls += 1;
      if (state.failReads) throw new Error('locked');
      return items.get(account);
    },
    async set(account, key) {
      items.set(account, key);
    },
    async remove(account) {
      items.delete(account);
    },
  };
  return { keychain, items, state };
}
