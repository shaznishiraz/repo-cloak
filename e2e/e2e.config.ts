import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  tests: [
    'dashboard.e2e.ts',
    '10-home.e2e.ts',
    'new-cloak.e2e.ts',
    'push.e2e.ts',
    'profiles.e2e.ts',
    'admin.e2e.ts',
    'integration.e2e.ts',
    '60-sync-engine.e2e.ts',
  ],
  workers: 1,
  retries: 0,
  reporters: ['list', 'junit'],
  targets: [
    {
      name: 'chromium',
      engine: web(),
      app: {
        url: 'http://127.0.0.1:0',
        command: { executable: process.execPath, args: ['.build/server.js', '{port}'] },
      },
    },
  ],
} satisfies E2EConfig;
