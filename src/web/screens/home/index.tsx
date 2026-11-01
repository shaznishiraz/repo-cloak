import { useEffect, useState } from 'preact/hooks';
import type { OverviewWorkspace } from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { navigate } from '../../shell/router.js';
import { overview } from '../../shell/state.js';
import { Badge, Button, EmptyState, buttonClass } from '../../shell/ui/index.js';
import { BulkDialog } from '../group/bulk.js';
import { GroupEditor } from '../group/editor.js';
import { reportError, request } from './actions.js';
import { WorkspaceDetailPanel } from './detail.js';
import './home.css';
import {
  needsAction,
  sectionWorkspaces,
  shortTime,
  workspaceBadges,
  workspaceDot,
} from './logic.js';
import type { GroupDetailView } from '../../api/contracts.js';

function WorkspaceRow({
  workspace,
  selected,
}: {
  workspace: OverviewWorkspace;
  selected: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        class={`ws-row${selected ? ' ws-row-on' : ''}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => navigate(`#/ws/${encodeURIComponent(workspace.id)}`)}
      >
        <span class="ws-row-top">
          <span class={`ws-dot dot-${workspaceDot(workspace)}`} aria-hidden="true" />
          <span class="mono ws-ellipsis ws-row-name">{workspace.name}</span>
          <span class="ws-row-when">{shortTime(workspace.lastUsedAt)}</span>
        </span>
        <span class="ws-row-meta">
          <span class="mono ws-small tone-2">
            {workspace.lineage.worktree?.branch ?? workspace.lineage.repo.name}
          </span>
          {workspaceBadges(workspace).map((badge) => (
            <Badge key={badge.label} tone={badge.tone}>
              {badge.label}
            </Badge>
          ))}
        </span>
      </button>
    </li>
  );
}

export function HomeScreen({ workspaceId }: { workspaceId?: string | undefined }) {
  const data = overview.value;
  const [groups, setGroups] = useState<GroupDetailView[]>([]);
  const [onlyAction, setOnlyAction] = useState(false);
  const [bulk, setBulk] = useState<{ group: GroupDetailView; direction: 'pull' | 'push' } | null>(
    null,
  );
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  const groupKey = JSON.stringify(data?.groups ?? []);
  useEffect(() => {
    if (!data?.groups.length) {
      setGroups([]);
      return;
    }
    let live = true;
    request(() => api().call('GET /api/v2/groups'))
      .then((value) => {
        if (live) setGroups(value.groups as GroupDetailView[]);
      })
      .catch(reportError);
    return () => {
      live = false;
    };
    // Membership only changes when the group list does, or after this screen edits a group.
  }, [groupKey, reload, !data]);

  if (!data)
    return (
      <main class="screen ws-loading" aria-label="Workspaces">
        Loading workspaces…
      </main>
    );
  if (!data.workspaces.length)
    return (
      <main class="screen" aria-label="Workspaces">
        <EmptyState
          title="No cloaked workspaces yet"
          action={
            <a class={buttonClass('primary')} href="#/new">
              + Cloak a repository
            </a>
          }
        >
          A cloak is a copy of selected files with proprietary names replaced.
        </EmptyState>
      </main>
    );

  const launched = data.launch.kind === 'workspace' ? data.launch.workspaceId : undefined;
  const selected =
    data.workspaces.find((item) => item.id === workspaceId) ??
    data.workspaces.find((item) => item.id === launched) ??
    data.workspaces[0];
  const sections = sectionWorkspaces(data.workspaces, data.groups, groups);
  const selectedSection = sections.find((section) =>
    section.items.some((item) => item.id === selected?.id),
  );
  const selectedGroup = groups.find((group) => group.id === selectedSection?.id);
  const visible = sections
    .map((section) => ({
      ...section,
      items: onlyAction ? section.items.filter(needsAction) : section.items,
    }))
    .filter((section) => section.items.length);
  const bulkTitle = selectedGroup
    ? undefined
    : 'Select a workspace in a group to run its bulk sync';

  return (
    <main class="screen ws-screen" aria-label="Workspaces">
      <section class="ws-list" aria-label="Workspaces">
        <div class="ws-toolbar">
          <span class="ws-toolbar-title">Workspaces</span>
          <Button
            size="small"
            aria-pressed={onlyAction}
            class={onlyAction ? 'ws-toggle-on' : ''}
            onClick={() => setOnlyAction(!onlyAction)}
          >
            Needs action
          </Button>
          <Button
            size="small"
            disabled={!selectedGroup}
            title={bulkTitle}
            aria-label={selectedGroup ? `Pull all in ${selectedGroup.name}` : 'Pull all'}
            onClick={() => selectedGroup && setBulk({ group: selectedGroup, direction: 'pull' })}
          >
            ↓ Pull all
          </Button>
          <Button
            size="small"
            disabled={!selectedGroup}
            title={bulkTitle}
            aria-label={selectedGroup ? `Push all in ${selectedGroup.name}` : 'Push all'}
            onClick={() => selectedGroup && setBulk({ group: selectedGroup, direction: 'push' })}
          >
            ↑ Push all
          </Button>
        </div>
        <div class="ws-scroll">
          {visible.map((section) => (
            <div key={section.id ?? 'ungrouped'} class="ws-section">
              <div class="ws-section-head">
                {section.id ? (
                  <a href={`#/groups/${encodeURIComponent(section.id)}`}>{section.name}</a>
                ) : (
                  <span>{section.name}</span>
                )}
                {section.note && <span class="mono ws-section-note">{section.note}</span>}
              </div>
              <ul class="ws-rows" aria-label={section.name}>
                {section.items.map((item) => (
                  <WorkspaceRow
                    key={item.id}
                    workspace={item}
                    selected={item.id === selected?.id}
                  />
                ))}
              </ul>
            </div>
          ))}
          {!visible.length && <p class="ws-empty">Every workspace is clean.</p>}
          <div class="ws-list-foot">
            <Button size="small" variant="ghost" onClick={() => setCreating(true)}>
              + Group
            </Button>
          </div>
        </div>
      </section>
      {selected && (
        <WorkspaceDetailPanel
          key={selected.id}
          workspace={selected}
          groupName={selectedSection?.id ? selectedSection.name : 'none'}
        />
      )}
      {bulk && (
        <BulkDialog
          group={bulk.group}
          direction={bulk.direction}
          selected={bulk.group.members.map((member) => member.repoId)}
          onClose={() => setBulk(null)}
          onDone={() => setReload((value) => value + 1)}
        />
      )}
      {creating && (
        <GroupEditor
          onClose={() => setCreating(false)}
          onSaved={(group) => {
            setCreating(false);
            setReload((value) => value + 1);
            navigate(`#/groups/${encodeURIComponent(group.id)}`);
          }}
        />
      )}
    </main>
  );
}
