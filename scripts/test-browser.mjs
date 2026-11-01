/* global process */
import { build } from 'tsup';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';

await build({
  config: false,
  entry: ['e2e/server.ts'],
  outDir: 'e2e/.build',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
});
// Specs change the fixture's data, so each one gets its own server and a fresh copy.
const specs = (await readdir('e2e')).filter((name) => name.endsWith('.e2e.ts')).sort();
let failed = 0;
for (const spec of specs) {
  const code = await new Promise((done, fail) => {
    const child = spawn(process.execPath, ['node_modules/e2e/dist/cli/bin.js', 'run', spec], {
      cwd: 'e2e',
      stdio: 'inherit',
      env: { ...process.env, E2E_TELEMETRY_DISABLED: '1' },
    });
    child.on('error', fail);
    child.on('exit', done);
  });
  if (code !== 0) failed += 1;
}
process.stdout.write(`Browser specs: ${specs.length - failed} of ${specs.length} passed\n`);
process.exitCode = failed ? 1 : 0;
