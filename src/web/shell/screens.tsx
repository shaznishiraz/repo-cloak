import type { Route } from './router.js';
import { EmptyState, buttonClass } from './ui/index.js';
import { GroupScreen } from '../screens/group/index.js';
import { HistoryScreen } from '../screens/history/index.js';
import { HomeScreen } from '../screens/home/index.js';
import { NewCloakScreen } from '../screens/new/index.js';
import { ProfilesScreen } from '../screens/profiles/index.js';
import { PushScreen } from '../screens/push/index.js';
import { ReposScreen } from '../screens/repos/index.js';
import { RequestsScreen } from '../screens/requests/index.js';
import { SettingsScreen } from '../screens/settings/index.js';
import { SetupScreen } from '../screens/setup/index.js';

export function Screen({ route }: { route: Route }) {
  switch (route.screen) {
    case 'home':
      return <HomeScreen workspaceId={route.workspaceId} />;
    case 'new':
      return (
        <NewCloakScreen
          key={`${route.repoId ?? ''}:${route.worktree ?? ''}`}
          repoId={route.repoId}
          worktree={route.worktree}
        />
      );
    case 'push':
      return <PushScreen workspaceId={route.workspaceId} />;
    case 'group':
      return <GroupScreen groupId={route.groupId} />;
    case 'repos':
      return <ReposScreen />;
    case 'requests':
      return <RequestsScreen />;
    case 'profiles':
      return <ProfilesScreen profileId={route.profileId} json={route.json} />;
    case 'history':
      return <HistoryScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'setup':
      return <SetupScreen />;
    case 'not-found':
      return (
        <main class="screen" aria-label="Not found">
          <EmptyState
            title="Page not found"
            action={
              <a class={buttonClass('secondary')} href="#/">
                Back to workspaces
              </a>
            }
          >
            Nothing lives at this address.
          </EmptyState>
        </main>
      );
  }
}
