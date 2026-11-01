/** Where `repo-cloak` was launched from, as passed in the URL fragment. */
export type LaunchParams = {
  repo?: string;
  worktree?: string;
  workspace?: string;
  group?: string;
};
export type BrowserSession = { token: string | null; launch: LaunchParams; route: string };
type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;

const tokenKey = 'cloak-token';
const launchKey = 'cloak-launch';
const launchFields = ['repo', 'worktree', 'workspace', 'group'] as const;

function landingRoute(launch: LaunchParams): string {
  if (launch.workspace) return `#/ws/${encodeURIComponent(launch.workspace)}`;
  if (launch.group) return `#/groups/${encodeURIComponent(launch.group)}`;
  return '#/';
}
function storedLaunch(storage: SessionStore): LaunchParams {
  try {
    return JSON.parse(storage.getItem(launchKey) ?? '{}') as LaunchParams;
  } catch {
    return {};
  }
}

/**
 * Moves the launch fragment (`#token=...&repo=...`) into sessionStorage so the token
 * leaves the address bar and history. A plain route fragment keeps the current session.
 */
export function readSession(hash: string, storage: SessionStore): BrowserSession {
  const params = new URLSearchParams(hash.startsWith('#/') ? '' : hash.slice(1));
  const incoming = params.get('token');
  if (!incoming)
    return {
      token: storage.getItem(tokenKey),
      launch: storedLaunch(storage),
      route: hash || '#/',
    };
  const launch: LaunchParams = {};
  for (const field of launchFields) {
    const value = params.get(field);
    if (value) launch[field] = value;
  }
  storage.setItem(tokenKey, incoming);
  storage.setItem(launchKey, JSON.stringify(launch));
  return { token: incoming, launch, route: landingRoute(launch) };
}
