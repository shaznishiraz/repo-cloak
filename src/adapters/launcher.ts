import { createDashboard } from '../application/dashboard.js';
import { createStore } from './store.js';
import { startUiSession } from './ui-session.js';

export async function runUi(
  write: (text: string) => void,
  options: { port?: number; open?: boolean; cwd?: string } = {},
) {
  const store = createStore();
  const dashboard = createDashboard(store, options.cwd);
  const context = await dashboard.context();
  const session = await startUiSession(store.root, dashboard, options.port);
  await dashboard.agents.refreshDescriptors();
  const fragment = new URLSearchParams({ token: session.token });
  if (context.repoId) fragment.set('repo', context.repoId);
  if (context.worktree) fragment.set('worktree', context.worktree);
  if (context.workspaceId) fragment.set('workspace', context.workspaceId);
  if ('groupId' in context && context.groupId) fragment.set('group', context.groupId);
  const url = `http://127.0.0.1:${session.port}/#${fragment}`;
  if (!session.reused) {
    const stop = () => {
      void session
        .close()
        .catch((error: unknown) => {
          process.stderr.write(
            `Could not close dashboard: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = 1;
        })
        .finally(() => {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  write(`${session.reused ? 'Using the running dashboard' : 'Dashboard running'} at ${url}\n`);
  if (!session.reused) write('Press Ctrl+C to stop.\n');
  if (options.open !== false) {
    try {
      const { default: openBrowser } = await import('open');
      await openBrowser(url, { wait: false });
    } catch {
      process.stderr.write('Could not open a browser automatically. Open the address above.\n');
    }
  }
}
