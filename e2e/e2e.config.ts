import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  tests: ['dashboard.e2e.ts'],
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
