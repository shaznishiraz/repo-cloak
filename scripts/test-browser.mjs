/* global process */
import { build } from 'tsup';
import { spawn } from 'node:child_process';

await build({
  config: false,
  entry: ['e2e/server.ts'],
  outDir: 'e2e/.build',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
});
const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'run'], {
  cwd: 'e2e',
  stdio: 'inherit',
  env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' },
});
child.on('error', (error) => {
  throw error;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
