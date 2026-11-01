import { ApiError, createClient, poll } from '../api/client.js';
import type { ApiClient } from '../api/client.js';
import type { LaunchQuery } from '../api/contracts.js';
import type { BrowserSession } from '../api/session.js';
import { loadError, overview, sessionInfo } from './state.js';

let active: ApiClient | undefined;
/** The session's client, for screens. Only null before the shell has a token. */
export function api(): ApiClient {
  if (!active) throw new Error('The dashboard session has not started');
  return active;
}

function launchQuery(session: BrowserSession): LaunchQuery {
  const { repo, worktree, workspace, group } = session.launch;
  return {
    ...(repo ? { repo } : {}),
    ...(worktree ? { worktree } : {}),
    ...(workspace ? { workspace } : {}),
    ...(group ? { group } : {}),
  };
}
function describe(error: unknown) {
  if (error instanceof ApiError && error.status === 401)
    return 'This dashboard session has ended. Run repo-cloak again to get a new link.';
  return error instanceof Error ? error.message : 'Could not reach the dashboard';
}

/** Connects the shell to the server; returns a function that stops refreshing. */
export function startSession(session: BrowserSession, request?: typeof fetch) {
  if (!session.token) {
    loadError.value = 'Open the link printed by repo-cloak; this tab has no session token.';
    return () => {};
  }
  const client = createClient(session.token, request);
  active = client;
  const query = launchQuery(session);
  return poll(
    async () =>
      Promise.all([
        client.call('GET /api/v2/session'),
        client.call('GET /api/v2/overview', { query }),
      ]),
    {
      onData([info, data]) {
        sessionInfo.value = info;
        overview.value = data;
        loadError.value = null;
      },
      onError(error) {
        loadError.value = describe(error);
      },
    },
  );
}
