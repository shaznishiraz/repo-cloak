import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import './shell.css';
import type { LaunchContext } from '../api/contracts.js';
import { Palette, openPalette, paletteOpen } from './palette.js';
import { navigate, route } from './router.js';
import type { Route } from './router.js';
import { Screen } from './screens.js';
import { loadError, overview, sessionInfo } from './state.js';
import { Kbd, Mono, ToastHost, buttonClass } from './ui/index.js';

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return (
    !!element?.closest?.('input, textarea, select, [contenteditable="true"]') ||
    element?.tagName === 'DIALOG'
  );
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        paletteOpen.value = !paletteOpen.value;
      } else if (
        event.key.toLowerCase() === 'n' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTyping(event.target) &&
        !paletteOpen.value
      ) {
        event.preventDefault();
        navigate('#/new');
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
}

function LaunchChip({ launch }: { launch: LaunchContext | undefined }) {
  if (!launch || launch.kind === 'none') return null;
  return (
    <div class="launch-chip" title={launch.path ?? undefined}>
      <span class="launch-from">opened from</span>
      <span class="launch-label">{launch.label}</span>
      {launch.branch && (
        <>
          <span class="launch-from">·</span>
          <span class="launch-branch">{launch.branch}</span>
        </>
      )}
    </div>
  );
}

function StoreChip() {
  const store = sessionInfo.value?.store;
  if (!store) return null;
  if (!store.sealed) return <span class="store-chip store-chip-new">Store not created yet</span>;
  return (
    <span
      class="store-chip"
      title={store.storage === 'keychain' ? 'Key in OS keychain' : 'Key file'}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
      </svg>
      Store sealed · key {store.keyId?.replace(/^k_/, '').slice(0, 4)}
    </span>
  );
}

function TopBar() {
  return (
    <header class="topbar">
      <a class="logo" href="#/" aria-label="repo-cloak home">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          aria-hidden="true"
        >
          <path d="M3 12c2-5 5.5-7.5 9-7.5S19 7 21 12c-2 5-5.5 7.5-9 7.5S5 17 3 12z" />
          <path d="M8 12h8" stroke-dasharray="2 2" />
        </svg>
        <span class="logo-name">repo-cloak</span>
        {sessionInfo.value && <span class="logo-version">v{sessionInfo.value.version}</span>}
      </a>
      <LaunchChip launch={overview.value?.launch} />
      <div class="topbar-end">
        <button type="button" class="search" onClick={openPalette}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            aria-hidden="true"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <span class="search-text">Jump to workspace, file, command…</span>
          <Kbd>⌘K</Kbd>
        </button>
        <StoreChip />
        <a class={buttonClass('primary')} href="#/new">
          + Cloak <span class="cta-key">N</span>
        </a>
      </div>
    </header>
  );
}

function RailLink({
  href,
  active,
  count,
  attention,
  children,
}: {
  href: string;
  active: boolean;
  count?: number | undefined;
  attention?: boolean;
  children: ComponentChildren;
}) {
  return (
    <a class="rail-link" href={href} aria-current={active ? 'page' : undefined}>
      <span>{children}</span>
      {count !== undefined && (
        <span class={attention && count > 0 ? 'rail-count rail-count-attention' : 'rail-count'}>
          {count}
        </span>
      )}
    </a>
  );
}

function Rail({ current }: { current: Route }) {
  const data = overview.value;
  const at = (screen: Route['screen']) => current.screen === screen;
  const workspaceCount = data?.workspaces.length ?? 0;
  return (
    <nav class="rail" aria-label="Primary">
      <RailLink href="#/" active={at('home') || at('push')} count={data?.workspaces.length}>
        Workspaces
      </RailLink>
      <RailLink href="#/repos" active={at('repos')} count={data?.repos.length}>
        Known repos
      </RailLink>
      <RailLink
        href="#/requests"
        active={at('requests')}
        count={data?.pendingAgentRequests}
        attention
      >
        Agent requests
      </RailLink>
      <RailLink href="#/profiles" active={at('profiles')} count={data?.profileCount}>
        Profiles
      </RailLink>
      <RailLink href="#/history" active={at('history')}>
        History
      </RailLink>
      <RailLink href="#/settings" active={at('settings')}>
        Settings
      </RailLink>
      <div class="rail-heading">Groups</div>
      {data?.groups.map((group) => (
        <RailLink
          key={group.id}
          href={`#/groups/${encodeURIComponent(group.id)}`}
          active={current.screen === 'group' && current.groupId === group.id}
          count={group.workspaceCount}
        >
          {group.name}
        </RailLink>
      ))}
      {data && !data.groups.length && <div class="rail-none">No groups yet</div>}
      <div class="rail-foot">
        <Mono muted>
          {data?.workspacesRoot ?? 'no cloak root'} · {workspaceCount}{' '}
          {workspaceCount === 1 ? 'workspace' : 'workspaces'}
          <br />
          ui 127.0.0.1:{sessionInfo.value?.port ?? location.port}
        </Mono>
      </div>
    </nav>
  );
}

/** Sends a brand new store to first run once; after that, home stays reachable. */
function useFirstRun() {
  const data = overview.value;
  const checked = useRef(false);
  useEffect(() => {
    if (!data || checked.current) return;
    checked.current = true;
    const here = route.value;
    if (
      data.workspacesRoot === null &&
      !data.workspaces.length &&
      here.screen === 'home' &&
      !here.workspaceId
    )
      navigate('#/setup');
  }, [data]);
}

export function Shell() {
  useGlobalKeys();
  useFirstRun();
  const current = route.value;
  return (
    <div class="shell">
      <TopBar />
      {loadError.value && (
        <div class="shell-error" role="alert">
          {loadError.value}
        </div>
      )}
      <div class="shell-body">
        <Rail current={current} />
        <Screen route={current} />
      </div>
      <Palette />
      <ToastHost />
    </div>
  );
}
