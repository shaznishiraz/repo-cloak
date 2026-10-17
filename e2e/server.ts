import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStore } from '../src/adapters/store.js';
import { runGit } from '../src/adapters/git.js';
import { createSyncServices } from '../src/adapters/sync-services.js';
import { createSyncCommand } from '../src/commands/sync.js';
import { createDashboard } from '../src/commands/dashboard.js';
import { createDashboardServer } from '../src/adapters/server.js';

// Only synthetic data lives here. Never use the user's machine store.
const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak browser ')));
const store = createStore(join(root, 'store'));
const source = join(root, 'sample-source');
const workspace = join(root, 'sample-workspace');
const server = createDashboardServer(
  createDashboard(store, source),
  'browser-test-token',
  resolve('../dist/ui'),
);
let closing: Promise<void> | undefined;
function close() {
  return (closing ??= (async () => {
    if (server.listening) {
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    }
    await rm(root, { recursive: true, force: true });
  })());
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
try {
  await mkdir(source);
  await runGit(source, ['init', '-b', 'main']);
  await runGit(source, [
    '-c',
    'core.hooksPath=' + join(root, 'no-hooks'),
    '-c',
    'commit.gpgSign=false',
    '-c',
    'user.name=Browser Test',
    '-c',
    'user.email=browser@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'Initial fixture',
  ]);
  await writeFile(join(source, 'Acme.txt'), 'Hello Acme\n');
  const services = createSyncServices(source, store);
  services.interactive = false;
  await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
  await services.profiles.save(
    { kind: 'global' },
    {
      kind: 'profile',
      schemaVersion: 1,
      name: 'sample',
      rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    },
  );
  await createSyncCommand(services, '2.0.0')('push', {
    profiles: ['sample'],
    files: ['Acme.txt'],
    to: workspace,
    yes: true,
  });
  await writeFile(join(workspace, 'Northwind.txt'), 'Edited Northwind\n');
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(Number(process.argv[2]), '127.0.0.1', done);
  });
} catch (error) {
  await close();
  throw error;
}
