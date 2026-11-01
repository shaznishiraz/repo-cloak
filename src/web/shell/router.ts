import { signal } from '@preact/signals';

export type Route =
  | { screen: 'home'; workspaceId?: string }
  | { screen: 'new'; repoId?: string; worktree?: string }
  | { screen: 'push'; workspaceId: string }
  | { screen: 'group'; groupId: string }
  | { screen: 'repos' }
  | { screen: 'requests' }
  | { screen: 'profiles'; profileId?: string; json?: boolean }
  | { screen: 'history' }
  | { screen: 'settings' }
  | { screen: 'setup' }
  | { screen: 'not-found'; hash: string };

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part) || undefined;
  } catch {
    return undefined;
  }
}

export function parseRoute(hash: string): Route {
  const notFound: Route = { screen: 'not-found', hash };
  if (hash === '' || hash === '#') return { screen: 'home' };
  if (!hash.startsWith('#/')) return notFound;
  if (hash.startsWith('#/new?')) {
    const query = new URLSearchParams(hash.slice('#/new?'.length));
    const repoId = query.get('repo');
    const worktree = query.get('worktree');
    return repoId && worktree ? { screen: 'new', repoId, worktree } : { screen: 'new' };
  }
  const path = hash.slice(2).replace(/\/$/, '');
  const parts = path ? path.split('/') : [];
  const [head, id, tail] = parts;
  if (head === undefined) return { screen: 'home' };
  if (parts.length === 1) {
    if (head === 'new') return { screen: 'new' };
    if (head === 'repos') return { screen: 'repos' };
    if (head === 'requests') return { screen: 'requests' };
    if (head === 'profiles') return { screen: 'profiles' };
    if (head === 'history') return { screen: 'history' };
    if (head === 'settings') return { screen: 'settings' };
    if (head === 'setup') return { screen: 'setup' };
    return notFound;
  }
  const value = decode(id ?? '');
  if (!value) return notFound;
  if (head === 'ws' && parts.length === 2) return { screen: 'home', workspaceId: value };
  if (head === 'ws' && parts.length === 3 && tail === 'push')
    return { screen: 'push', workspaceId: value };
  if (head === 'groups' && parts.length === 2) return { screen: 'group', groupId: value };
  if (head === 'profiles' && parts.length === 2) return { screen: 'profiles', profileId: value };
  if (head === 'profiles' && parts.length === 3 && tail === 'json')
    return { screen: 'profiles', profileId: value, json: true };
  return notFound;
}

export const route = signal<Route>(parseRoute(globalThis.location?.hash ?? ''));

export function navigate(hash: string) {
  if (location.hash === hash) route.value = parseRoute(hash);
  else location.hash = hash;
}

/** Follows the address bar; returns the listener's cleanup. */
export function startRouter() {
  const sync = () => {
    route.value = parseRoute(location.hash);
  };
  sync();
  addEventListener('hashchange', sync);
  return () => removeEventListener('hashchange', sync);
}
