import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

// Separate from e2e.config.ts while the screen packages land in parallel. Run from e2e/ with
// `npx e2e run --config push.e2e.config.ts` after building .build/server.js.
export default {
  tests: ['push.e2e.ts'],
  workers: 1,
  retries: 0,
  reporters: ['list'],
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
