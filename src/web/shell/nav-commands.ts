import { registerCommands } from './commands.js';
import type { Command } from './commands.js';
import { navigate } from './router.js';
import { overview } from './state.js';

const pages: [string, string, string][] = [
  ['Workspaces', '#/', 'home'],
  ['New cloak', '#/new', 'create'],
  ['Known repos', '#/repos', 'repositories worktrees'],
  ['Agent requests', '#/requests', 'approve deny'],
  ['Profiles', '#/profiles', 'rules exclusions'],
  ['History', '#/history', 'audit log'],
  ['Settings', '#/settings', 'security keychain policy'],
  ['First run setup', '#/setup', 'onboarding'],
];

/** Pages, workspaces and groups: what every palette can reach without a screen loaded. */
export function shellCommands(): Command[] {
  const data = overview.value;
  const go = pages.map(([title, hash, keywords]) => ({
    id: `go${hash.replaceAll('/', '-').replace('#', '')}`,
    group: 'Go to',
    title,
    icon: '→',
    keywords: [keywords],
    run: () => navigate(hash),
  }));
  const workspaces = (data?.workspaces ?? []).map((workspace) => ({
    id: `ws-${workspace.id}`,
    group: 'Workspaces',
    title: workspace.name,
    subtitle: workspace.path,
    icon: '◆',
    run: () => navigate(`#/ws/${encodeURIComponent(workspace.id)}`),
  }));
  const pushes = (data?.workspaces ?? [])
    .filter((workspace) => workspace.state === 'to-push')
    .map((workspace) => ({
      id: `push-${workspace.id}`,
      group: 'Actions',
      title: `Push ${workspace.name}`,
      subtitle: `${workspace.counts.modified + workspace.counts.added + workspace.counts.deleted} files`,
      icon: '↑',
      run: () => navigate(`#/ws/${encodeURIComponent(workspace.id)}/push`),
    }));
  const groups = (data?.groups ?? []).map((group) => ({
    id: `group-${group.id}`,
    group: 'Groups',
    title: group.name,
    subtitle: `${group.workspaceCount} workspaces`,
    icon: '▤',
    run: () => navigate(`#/groups/${encodeURIComponent(group.id)}`),
  }));
  return [...pushes, ...workspaces, ...groups, ...go];
}

export function registerShellCommands() {
  return registerCommands(shellCommands);
}
