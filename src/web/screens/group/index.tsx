import { useEffect, useState } from 'preact/hooks';
import type { DesktopOption, DesktopTarget, PushTarget } from '../../api/contracts.js';
import { registerCommands } from '../../shell/commands.js';
import { api } from '../../shell/load.js';
import { navigate } from '../../shell/router.js';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Menu,
  toast,
  buttonClass,
} from '../../shell/ui/index.js';
import { errorText, refreshOverview, reportError, request } from '../home/actions.js';
import '../home/home.css';
import { clockTime, historyText, historyTone } from '../home/logic.js';
import type { GroupDetailView, GroupMemberView } from '../home/types.js';
import { BulkDialog } from './bulk.js';
import { GroupEditor, JoinDialog } from './editor.js';
import './group.css';
import { readRules, saveRules } from './rules.js';

function targetLabel(target: PushTarget) {
  if (target.kind === 'origin') return 'push → same worktree';
  if (target.kind === 'main') return 'push → main checkout';
  if (target.kind === 'worktree') return `push → ${target.path.split('/').pop() ?? target.path}`;
  return 'push → default';
}

function MemberRow({
  member,
  checked,
  onToggle,
  onRetarget,
}: {
  member: GroupMemberView;
  checked: boolean;
  onToggle: (value: boolean) => void;
  onRetarget: (worktree: string) => void;
}) {
  const choices = member.worktrees.filter((tree) => tree.path !== member.worktree);
  return (
    <div class="grp-row" role="row" data-repo={member.repoId}>
      <span role="cell">
        <input
          type="checkbox"
          class="grp-check"
          aria-label={`Include ${member.folder} in bulk action`}
          checked={checked}
          onChange={(event) => onToggle(event.currentTarget.checked)}
        />
      </span>
      <span role="cell" class="mono grp-folder">
        {member.folder}
      </span>
      <span role="cell" class="grp-source">
        <span class="mono ws-ellipsis">{member.source}</span>
        <span class="ws-small tone-muted grp-target">
          {targetLabel(member.target)}{' '}
          <Menu
            label={`Change push target of ${member.folder}`}
            trigger="change"
            triggerClass="ws-link"
            items={
              choices.length
                ? choices.map((tree, index) => ({
                    label: tree.branch ?? tree.path.split('/').pop() ?? tree.path,
                    hint: `${member.worktrees[0]?.path === tree.path && index === 0 ? 'main · ' : ''}${tree.path}`,
                    onSelect: () => onRetarget(tree.path),
                  }))
                : [{ label: 'No other worktrees', disabled: true, onSelect: () => {} }]
            }
          />
        </span>
      </span>
      <span role="cell" class={`mono ${member.toPush ? 'tone-push' : 'tone-muted'}`}>
        <span class="grp-cell-label">Push </span>
        {member.toPush ? `↑${member.toPush}` : '—'}
      </span>
      <span role="cell" class={`mono ${member.sourceMoved ? 'tone-pull' : 'tone-muted'}`}>
        <span class="grp-cell-label">Pull </span>
        {member.sourceMoved ? `↓${member.sourceMoved}` : '—'}
      </span>
      <span role="cell" class="grp-plan">
        {member.plan}
      </span>
    </div>
  );
}

function SharedFolder({
  group,
  onCreate,
  busy,
}: {
  group: GroupDetailView;
  onCreate: () => void;
  busy: boolean;
}) {
  if (!group.folder)
    return (
      <div class="grp-tree">
        <p class="grp-tree-none">
          No shared folder yet. Each member stays where it is. A shared folder lets an agent open
          every repo in one place.
        </p>
        <Button size="small" disabled={busy} onClick={onCreate}>
          Move members into a shared folder
        </Button>
      </div>
    );
  return (
    <ul class="grp-tree mono" aria-label="Shared folder">
      <li class="tone-text">{group.folder}/</li>
      <li class="grp-tree-child">
        AGENTS.md{' '}
        <span class="grp-tree-note">
          generated · explains layout, asks the agent to request files instead of guessing
        </span>
      </li>
      {group.members.map((member) => (
        <li key={member.repoId} class="grp-tree-child">
          <span class="tone-text">{member.folder}</span>{' '}
          <span class="tone-muted">{member.tracked} files</span>
        </li>
      ))}
      <li class="grp-tree-child tone-muted">
        .repo-cloak/{' '}
        <span class="grp-tree-note">sealed manifests only · no real names, no keys</span>
      </li>
    </ul>
  );
}

export function GroupScreen({ groupId }: { groupId: string }) {
  const [group, setGroup] = useState<GroupDetailView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [bulk, setBulk] = useState<'pull' | 'push' | null>(null);
  const [prompt, setPrompt] = useState<'edit' | 'join' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<GroupDetailView['rules'] | null>(null);
  const [desktop, setDesktop] = useState<Partial<Record<DesktopTarget, DesktopOption>>>({});
  const reload = () => setTick((value) => value + 1);

  useEffect(() => {
    let live = true;
    request(() => api().call('GET /api/v2/groups/:id', { params: { id: groupId } }))
      .then((value) => {
        if (!live) return;
        const view = value as GroupDetailView;
        setGroup(view);
        setRules(readRules(view.id, view.rules));
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (live) setFailure(errorText(error));
      });
    return () => {
      live = false;
    };
  }, [groupId, tick]);
  const hasFolder = !!group?.folder;
  useEffect(() => {
    if (!hasFolder) return;
    let live = true;
    request(() => api().call('GET /api/v2/desktop'))
      .then((value) => {
        if (live) setDesktop(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [hasFolder]);
  const name = group?.name;
  useEffect(
    () =>
      name === undefined
        ? undefined
        : registerCommands(() => [
            {
              id: 'group-pull',
              group: 'Actions',
              title: `Pull all in ${name}`,
              icon: '↓',
              run: () => setBulk('pull'),
            },
            {
              id: 'group-push',
              group: 'Actions',
              title: `Push all in ${name}`,
              icon: '↑',
              run: () => setBulk('push'),
            },
          ]),
    [name],
  );

  if (failure)
    return (
      <main class="screen" aria-label="Group sync" data-placeholder="10-home">
        <EmptyState
          title="Could not load this group"
          action={
            <a class={buttonClass('secondary')} href="#/">
              Back to workspaces
            </a>
          }
        >
          {failure}
        </EmptyState>
      </main>
    );
  if (!group || !rules)
    return (
      <main class="screen ws-loading" aria-label="Group sync" data-placeholder="10-home">
        Loading group…
      </main>
    );

  const selected = group.members
    .filter((member) => !excluded.includes(member.repoId))
    .map((member) => member.repoId);
  const chosen = group.members.filter((member) => selected.includes(member.repoId));
  const files = chosen.reduce((sum, member) => sum + member.toPush, 0);
  const pulls = chosen.filter((member) => member.sourceMoved > 0).length;

  async function saveMembers(next: GroupMemberView[], extra: object = {}) {
    if (!group) return;
    setBusy(true);
    try {
      await api().call('PUT /api/v2/groups/:id', {
        params: { id: group.id },
        body: {
          revision: group.revision,
          group: {
            name: group.name,
            members: next.map(({ repoId, workspaceId, worktree }) => ({
              repoId,
              workspaceId,
              worktree,
            })),
            ...extra,
          },
        },
      });
      await refreshOverview();
      reload();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  }
  async function removeGroup() {
    if (!group) return;
    setBusy(true);
    try {
      await api().call('DELETE /api/v2/groups/:id', {
        params: { id: group.id },
        body: { revision: group.revision },
      });
      toast(`Deleted group ${group.name}`, 'ok');
      await refreshOverview();
      navigate('#/');
    } catch (error) {
      reportError(error);
      setBusy(false);
      setPrompt(null);
    }
  }
  function changeRules(next: GroupDetailView['rules']) {
    if (!group) return;
    setRules(next);
    saveRules(group.id, next);
  }
  const openItems = (Object.entries(desktop) as [DesktopTarget, DesktopOption][]).map(
    ([target, option]) => ({
      label: option.label,
      disabled: !option.available,
      onSelect: () => {
        api()
          .call('POST /api/v2/groups/:id/open', { params: { id: group.id }, body: { target } })
          .catch(reportError);
      },
    }),
  );
  return (
    <main class="screen grp" aria-label="Group sync" data-placeholder="10-home">
      <header class="grp-head">
        <span class="tone-2">group</span>
        <h1 class="mono">{group.name}</h1>
        <span class="mono ws-small tone-muted grp-head-path">
          {group.folder ? `${group.folder} · ` : ''}
          {group.members.length} {group.members.length === 1 ? 'repo' : 'repos'}
        </span>
        <div class="grp-head-actions">
          {openItems.length > 0 && (
            <Menu label="Open group folder" trigger="Open" items={openItems} />
          )}
          <Button variant="ghost" onClick={() => setPrompt('edit')}>
            Edit
          </Button>
          <Button variant="ghost" onClick={() => setPrompt('delete')}>
            Delete
          </Button>
          <Button disabled={!selected.length} onClick={() => setBulk('pull')}>
            ↓ Pull all {pulls > 0 && <span class="mono tone-pull">{pulls}</span>}
          </Button>
          <span class="ws-push">
            <Button variant="primary" disabled={!selected.length} onClick={() => setBulk('push')}>
              ↑ Push all · {files} {files === 1 ? 'file' : 'files'}
            </Button>
          </span>
        </div>
      </header>
      <div class="grp-body">
        <div class="grp-main">
          <section class="ws-panel" aria-label="Members">
            <header class="ws-panel-head">
              <h2>Members</h2>
              <span class="ws-note">each repo keeps its own folder, source and manifest</span>
              <span class="ws-panel-action">
                <button type="button" class="ws-link" onClick={() => setPrompt('join')}>
                  + Add repo to group
                </button>
              </span>
            </header>
            <div class="grp-table" role="table" aria-label="Group members">
              <div class="grp-row grp-row-head" role="row">
                <span role="columnheader">
                  <span class="sr-only">Include</span>
                </span>
                <span role="columnheader">Cloak folder</span>
                <span role="columnheader">Source · push target</span>
                <span role="columnheader">Push</span>
                <span role="columnheader">Pull</span>
                <span role="columnheader">Plan</span>
              </div>
              {group.members.map((member) => (
                <MemberRow
                  key={member.repoId}
                  member={member}
                  checked={selected.includes(member.repoId)}
                  onToggle={(value) =>
                    setExcluded((current) =>
                      value
                        ? current.filter((id) => id !== member.repoId)
                        : [...current, member.repoId],
                    )
                  }
                  onRetarget={(worktree) =>
                    void saveMembers(
                      group.members.map((item) =>
                        item.repoId === member.repoId ? { ...item, worktree } : item,
                      ),
                    )
                  }
                />
              ))}
            </div>
          </section>
          <section class="ws-panel" aria-label="Shared folder">
            <header class="ws-panel-head">
              <h2>Shared folder</h2>
              {group.folder && (
                <span class="ws-note">what an agent sees when it opens this folder</span>
              )}
            </header>
            <SharedFolder
              group={group}
              busy={busy}
              onCreate={() => void saveMembers(group.members, { moveWorkspaces: true })}
            />
          </section>
        </div>
        <aside class="grp-side">
          <section class="ws-panel grp-pad" aria-label="Bulk rules">
            <h2 class="grp-h2">Bulk rules</h2>
            <Checkbox
              label="Stop all if any guard check fails"
              checked={rules.stopOnGuardFailure}
              onChange={(event) =>
                changeRules({ ...rules, stopOnGuardFailure: event.currentTarget.checked })
              }
            />
            <Checkbox
              label="Same commit message across repos"
              checked={rules.sameCommitMessage}
              onChange={(event) =>
                changeRules({ ...rules, sameCommitMessage: event.currentTarget.checked })
              }
            />
          </section>
          <section class="ws-panel grp-pad" aria-label="Last bulk runs">
            <h2 class="grp-h2">Last bulk runs</h2>
            {!group.runs.length && <p class="grp-tree-none">No runs yet.</p>}
            <ul class="grp-runs">
              {group.runs.map((event) => (
                <li key={event.seq}>
                  <span class="mono ws-small tone-muted">{clockTime(event.at)}</span>
                  <span class={`mono tone-${historyTone(event)}`}>{event.op}</span>
                  <span class="tone-2">{historyText(event)}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
      {bulk && (
        <BulkDialog
          group={group}
          direction={bulk}
          selected={selected}
          onClose={() => setBulk(null)}
          onDone={reload}
        />
      )}
      {prompt === 'edit' && (
        <GroupEditor
          group={group}
          onClose={() => setPrompt(null)}
          onSaved={() => {
            setPrompt(null);
            reload();
          }}
        />
      )}
      {prompt === 'join' && (
        <JoinDialog
          group={group}
          onClose={() => setPrompt(null)}
          onSaved={() => {
            setPrompt(null);
            reload();
          }}
        />
      )}
      {prompt === 'delete' && (
        <Dialog
          title={`Delete group ${group.name}?`}
          open
          onClose={() => setPrompt(null)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setPrompt(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void removeGroup()}>
                Delete group
              </Button>
            </>
          }
        >
          <p>The group is forgotten. Its workspaces and their folders stay as they are.</p>
        </Dialog>
      )}
    </main>
  );
}
