import { useState } from 'preact/hooks';
import type { GroupInput, OverviewWorkspace } from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { overview } from '../../shell/state.js';
import { Button, Checkbox, Dialog, Field, Radio } from '../../shell/ui/index.js';
import { errorText, refreshOverview } from '../home/actions.js';
import type { GroupDetailView } from '../home/types.js';

const worktreeOf = (workspace: OverviewWorkspace) =>
  workspace.lineage.worktree?.path ?? workspace.lineage.repo.path;

/** Create a group, or rename one and change its members. One repository per group. */
export function GroupEditor({
  group,
  onClose,
  onSaved,
}: {
  group?: GroupDetailView;
  onClose: () => void;
  onSaved: (group: GroupDetailView) => void;
}) {
  const workspaces = (overview.value?.workspaces ?? []).filter(
    (item) => item.state !== 'missing' && item.state !== 'unreadable',
  );
  const [name, setName] = useState(group?.name ?? '');
  const [chosen, setChosen] = useState<string[]>(
    group?.members.map((member) => member.workspaceId) ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const members = chosen.flatMap((id) => {
        const existing = group?.members.find((member) => member.workspaceId === id);
        if (existing)
          return [{ repoId: existing.repoId, workspaceId: id, worktree: existing.worktree }];
        const workspace = workspaces.find((item) => item.id === id);
        return workspace
          ? [{ repoId: workspace.repoId, workspaceId: id, worktree: worktreeOf(workspace) }]
          : [];
      });
      const input: GroupInput = { name: name.trim(), members };
      const saved = group
        ? await api().call('PUT /api/v2/groups/:id', {
            params: { id: group.id },
            body: { revision: group.revision, group: input },
          })
        : await api().call('POST /api/v2/groups', { body: input });
      await refreshOverview();
      onSaved(saved as GroupDetailView);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={group ? `Edit group ${group.name}` : 'New group'}
      open
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !name.trim() || !chosen.length}
            onClick={() => void save()}
          >
            Save group
          </Button>
        </>
      }
    >
      <Field label="Name" value={name} onInput={(event) => setName(event.currentTarget.value)} />
      <h3 class="op-list-title">Members</h3>
      <div class="export-files">
        {workspaces.map((workspace) => (
          <Checkbox
            key={workspace.id}
            checked={chosen.includes(workspace.id)}
            onChange={(event) =>
              setChosen((current) =>
                event.currentTarget.checked
                  ? [...current, workspace.id]
                  : current.filter((id) => id !== workspace.id),
              )
            }
            label={
              <span class="mono">
                {workspace.name} <span class="tone-muted">{workspace.lineage.repo.name}</span>
              </span>
            }
          />
        ))}
      </div>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** Adds one existing cloak to a group; creating a new one belongs to the New cloak sheet. */
export function JoinDialog({
  group,
  onClose,
  onSaved,
}: {
  group: GroupDetailView;
  onClose: () => void;
  onSaved: (group: GroupDetailView) => void;
}) {
  const repos = new Set(group.members.map((member) => member.repoId));
  const options = (overview.value?.workspaces ?? []).filter(
    (item) => !repos.has(item.repoId) && item.state !== 'missing' && item.state !== 'unreadable',
  );
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function join() {
    const workspace = options.find((item) => item.id === choice);
    if (!workspace) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api().call('POST /api/v2/groups/:id/members', {
        params: { id: group.id },
        body: {
          revision: group.revision,
          member: {
            repoId: workspace.repoId,
            workspaceId: workspace.id,
            worktree: worktreeOf(workspace),
          },
        },
      });
      await refreshOverview();
      onSaved(saved as GroupDetailView);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={`Add a repo to ${group.name}`}
      open
      onClose={onClose}
      actions={
        <>
          <a class="btn btn-ghost" href="#/new" onClick={onClose}>
            New cloak instead
          </a>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !choice} onClick={() => void join()}>
            Add to group
          </Button>
        </>
      }
    >
      {!options.length && <p>No other repository has a cloak yet.</p>}
      <div class="export-files">
        {options.map((workspace) => (
          <Radio
            key={workspace.id}
            name="join-workspace"
            checked={choice === workspace.id}
            onChange={() => setChoice(workspace.id)}
            label={
              <span class="mono">
                {workspace.name} <span class="tone-muted">{workspace.lineage.repo.name}</span>
              </span>
            }
          />
        ))}
      </div>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
