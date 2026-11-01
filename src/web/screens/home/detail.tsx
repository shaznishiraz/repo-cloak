import { useEffect, useState } from 'preact/hooks';
import type {
  AgentDecision,
  AgentRequest,
  DesktopOption,
  DesktopTarget,
  GuardCheck,
  OverviewWorkspace,
  PendingChange,
  PullTarget,
  PushTarget,
} from '../../api/contracts.js';
import { registerCommands } from '../../shell/commands.js';
import { api } from '../../shell/load.js';
import { navigate } from '../../shell/router.js';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Menu,
  SplitButton,
  toast,
} from '../../shell/ui/index.js';
import type { MenuItem } from '../../shell/ui/index.js';
import { copyText, errorText, refreshOverview, reportError, request } from './actions.js';
import { ExportDialog } from './export-dialog.js';
import {
  clockTime,
  defaultBranch,
  historyText,
  historyTone,
  lineageNodes,
  otherWorktrees,
  pullEntries,
  pushEntries,
  statCells,
  toPushCount,
} from './logic.js';
import { OperationDialog } from './operation-dialog.js';
import type { TargetPreview, WorkspaceDetailView } from './types.js';

const guardIcons: Record<GuardCheck['state'], string> = {
  ok: '✓',
  info: '↓',
  warning: '!',
  blocked: '✕',
};
const guardTones: Record<GuardCheck['state'], string> = {
  ok: 'ok',
  info: 'pull',
  warning: 'push',
  blocked: 'blocked',
};
const statusMarks: Record<PendingChange['status'], [string, string]> = {
  modified: ['M', 'push'],
  added: ['A', 'ok'],
  deleted: ['D', 'blocked'],
};

function Section({
  title,
  note,
  action,
  wide,
  children,
}: {
  title: string;
  note?: preact.ComponentChildren;
  action?: preact.ComponentChildren;
  wide?: boolean;
  children: preact.ComponentChildren;
}) {
  return (
    <section class={`ws-panel${wide ? ' ws-panel-wide' : ''}`} aria-label={title}>
      <header class="ws-panel-head">
        <h2>{title}</h2>
        {note && <span class="ws-note">{note}</span>}
        {action && <span class="ws-panel-action">{action}</span>}
      </header>
      {children}
    </section>
  );
}

function PendingPanel({ detail }: { detail: WorkspaceDetailView }) {
  const pushHref = `#/ws/${encodeURIComponent(detail.workspace.id)}/push`;
  return (
    <Section
      wide
      title="Pending changes"
      note="cloaked path → where it restores"
      action={detail.pending.length > 0 && <a href={pushHref}>Review push →</a>}
    >
      {detail.pending.length ? (
        <ul class="ws-changes">
          {detail.pending.map((change) => {
            const [mark, tone] = statusMarks[change.status];
            return (
              <li key={change.path} class="ws-change">
                <span class={`mono tone-${tone}`} title={change.status}>
                  {mark}
                  <span class="sr-only"> {change.status}</span>
                </span>
                <span class="ws-change-paths">
                  <span class="mono ws-ellipsis">{change.path}</span>
                  <span class="mono ws-ellipsis tone-muted">→ {change.restoredPath}</span>
                </span>
                <span class="mono ws-change-counts">
                  {change.additions > 0 && <span class="tone-ok">+{change.additions}</span>}{' '}
                  {change.deletions > 0 && <span class="tone-blocked">−{change.deletions}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p class="ws-empty">Nothing to push. Cloak matches what was last pulled or pushed.</p>
      )}
    </Section>
  );
}

function GuardPanel({ checks }: { checks: GuardCheck[] }) {
  return (
    <Section title="Guard" note="checked on load">
      <ul class="ws-guards">
        {checks.map((check) => (
          <li key={check.id} class="ws-guard" data-guard={check.id} data-state={check.state}>
            <span class={`mono tone-${guardTones[check.state]}`} aria-hidden="true">
              {guardIcons[check.state]}
            </span>
            <span class="ws-guard-text">
              <span>{check.title}</span>
              {check.detail && <span class="mono tone-muted ws-small">{check.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Rows sharing a request id are one decision; show them together. */
function groupRequests(requests: AgentRequest[]) {
  const byId = new Map<string, AgentRequest[]>();
  for (const request of requests) byId.set(request.id, [...(byId.get(request.id) ?? []), request]);
  return [...byId.values()];
}

function RequestsPanel({
  detail,
  onChanged,
}: {
  detail: WorkspaceDetailView;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const groups = groupRequests(detail.requests);
  async function decide(id: string, decision: AgentDecision) {
    setBusy(id);
    try {
      await api().call('POST /api/v2/requests/:workspaceId/:id', {
        params: { workspaceId: detail.workspace.id, id },
        body: decision,
      });
      toast(decision.decision === 'deny' ? 'Request denied' : 'Request approved', 'ok');
      onChanged();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Section
      title="Agent requests"
      note={groups.length > 0 && <Badge tone="accent">{groups.length} waiting</Badge>}
      action={<a href="#/requests">All requests</a>}
    >
      {!groups.length && <p class="ws-empty">No files waiting for approval.</p>}
      <ul class="ws-requests">
        {groups.map((files) => {
          const first = files[0];
          if (!first) return null;
          const blocked = files.filter((file) => file.state === 'blocked');
          const allBlocked = blocked.length === files.length;
          return (
            <li key={first.id} class="ws-request" data-request={first.id}>
              {files.map((file) => (
                <div key={file.path} class="mono ws-ellipsis">
                  {file.path}
                </div>
              ))}
              {blocked.length > 0 ? (
                <p class="ws-request-reason tone-blocked">
                  Blocked:{' '}
                  {blocked.length === 1 ? 'this file matches' : `${blocked.length} files match`} an
                  exclusion
                </p>
              ) : (
                <p class="ws-request-reason">“{first.reason}”</p>
              )}
              <div class="ws-request-actions">
                {!allBlocked && (
                  <Button
                    size="small"
                    variant="primary"
                    disabled={busy !== null}
                    onClick={() => void decide(first.id, { decision: 'approve', mode: 'full' })}
                  >
                    Approve &amp; pull
                  </Button>
                )}
                {blocked.length > 0 && (
                  <Button
                    size="small"
                    disabled={busy !== null}
                    onClick={() =>
                      void decide(first.id, { decision: 'approve', mode: 'signatures' })
                    }
                  >
                    Send stub instead
                  </Button>
                )}
                <Button
                  size="small"
                  disabled={busy !== null}
                  onClick={() => void decide(first.id, { decision: 'deny' })}
                >
                  Deny
                </Button>
                <span class="ws-note">
                  {files.length} {files.length === 1 ? 'file' : 'files'}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function HistoryPanel({ detail }: { detail: WorkspaceDetailView }) {
  return (
    <Section
      wide
      title="History"
      note="sealed manifest · tamper-checked"
      action={<a href="#/history">Full trail</a>}
    >
      {detail.history.length ? (
        <ul class="ws-history">
          {detail.history.map((event) => (
            <li key={event.seq} class="ws-history-row">
              <span class="mono tone-muted ws-small">{clockTime(event.at)}</span>
              <span class={`mono tone-${historyTone(event)}`}>{event.op}</span>
              <span class="tone-2">{historyText(event)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="ws-empty">No recorded events for this workspace yet.</p>
      )}
    </Section>
  );
}

type Operation =
  | { direction: 'pull'; target: PullTarget; title: string }
  | { direction: 'push'; target: PushTarget; title: string };
type Prompt = 'pull-other' | 'push-other' | 'new-worktree' | 'delete' | 'export' | null;

function pushTitle(target: PushTarget) {
  if (target.kind === 'patch') return 'Export restored .patch';
  if (target.kind === 'dry-run') return 'Dry run: restored diff';
  return 'Push';
}

function WorktreePicker({
  detail,
  direction,
  onPick,
  onClose,
}: {
  detail: WorkspaceDetailView;
  direction: 'pull' | 'push';
  onPick: (target: { kind: 'worktree'; path: string } | { kind: 'commit'; ref: string }) => void;
  onClose: () => void;
}) {
  const [ref, setRef] = useState('');
  const others = otherWorktrees(detail);
  return (
    <Dialog
      title={direction === 'pull' ? 'Pull from' : 'Restore into'}
      open
      onClose={onClose}
      actions={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      {!others.length && <p class="ws-empty">No other worktrees found.</p>}
      <ul class="ws-picker">
        {others.map((tree) => (
          <li key={tree.path}>
            <button
              type="button"
              class="export-row"
              onClick={() => onPick({ kind: 'worktree', path: tree.path })}
            >
              <span class="mono">{tree.path}</span>{' '}
              <span class="mono tone-muted">{tree.branch ?? 'detached'}</span>
            </button>
          </li>
        ))}
      </ul>
      {direction === 'pull' && (
        <form
          class="export-search"
          onSubmit={(event) => {
            event.preventDefault();
            if (ref.trim()) onPick({ kind: 'commit', ref: ref.trim() });
          }}
        >
          <Field
            label="Or pull the files changed by a commit"
            hint="A branch, tag or sha. Contents come from the worktree it came from."
            value={ref}
            onInput={(event) => setRef(event.currentTarget.value)}
          />
          <Button type="submit">Preview</Button>
        </form>
      )}
    </Dialog>
  );
}

function NewWorktreePrompt({
  name,
  onSubmit,
  onClose,
}: {
  name: string;
  onSubmit: (branch: string) => void;
  onClose: () => void;
}) {
  const [branch, setBranch] = useState(defaultBranch(name));
  return (
    <Dialog
      title="New worktree from main"
      open
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!branch.trim()}
            onClick={() => onSubmit(branch.trim())}
          >
            Preview
          </Button>
        </>
      }
    >
      <Field
        label="New branch"
        value={branch}
        onInput={(event) => setBranch(event.currentTarget.value)}
      />
    </Dialog>
  );
}

function DeleteDialog({
  workspace,
  onClose,
}: {
  workspace: OverviewWorkspace;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api().call('DELETE /api/v2/workspaces/:repoId/:id', {
        params: { repoId: workspace.repoId, id: workspace.id },
        body: { path: workspace.path, confirm: true },
      });
      toast(`Deleted ${workspace.name}`, 'ok');
      await refreshOverview();
      onClose();
      navigate('#/');
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Delete this cloak?"
      open
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>
            Delete cloak
          </Button>
        </>
      }
    >
      <p>
        This removes the cloak folder and forgets it. The source repository is not touched. Changes
        not pushed yet are lost.
      </p>
      <p class="mono">{workspace.path}</p>
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function OpenMenu({ workspace }: { workspace: OverviewWorkspace }) {
  const [options, setOptions] = useState<Partial<Record<DesktopTarget, DesktopOption>>>({});
  useEffect(() => {
    let live = true;
    request(() => api().call('GET /api/v2/desktop'))
      .then((value) => {
        if (live) setOptions(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const items: MenuItem[] = (Object.entries(options) as [DesktopTarget, DesktopOption][]).map(
    ([target, option]) => ({
      label: option.label,
      disabled: !option.available,
      ...(!option.available && option.unavailableReason ? { hint: option.unavailableReason } : {}),
      onSelect: () => {
        api()
          .call('POST /api/v2/workspaces/:repoId/:id/open', {
            params: { repoId: workspace.repoId, id: workspace.id },
            body: { target },
          })
          .catch(reportError);
      },
    }),
  );
  return (
    <Menu
      label="Open in editor"
      trigger="open in editor"
      triggerClass="ws-link"
      items={items.length ? items : [{ label: 'Checking…', disabled: true, onSelect: () => {} }]}
    />
  );
}

export function WorkspaceDetailPanel({
  workspace,
  groupName,
}: {
  workspace: OverviewWorkspace;
  groupName: string;
}) {
  const [detail, setDetail] = useState<WorkspaceDetailView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  // The overview polls; only reload the expensive detail when this workspace actually changed.
  const version = JSON.stringify(workspace);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    request(() =>
      api().call('GET /api/v2/workspaces/:repoId/:id', {
        params: { repoId: workspace.repoId, id: workspace.id },
      }),
    )
      .then((value) => {
        if (!live) return;
        setDetail(value as WorkspaceDetailView);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (live) setFailure(errorText(error));
      });
    return () => {
      live = false;
    };
  }, [workspace.repoId, workspace.id, version, tick]);
  const shown = detail?.workspace.id === workspace.id ? detail : null;
  const unavailable = workspace.state === 'missing' || workspace.state === 'unreadable';

  function refresh() {
    setTick((value) => value + 1);
    refreshOverview().catch(reportError);
  }
  function pull(target: PullTarget) {
    setOperation({ direction: 'pull', target, title: 'Pull' });
  }
  function push(target: PushTarget) {
    setOperation({ direction: 'push', target, title: pushTitle(target) });
  }
  useEffect(
    () =>
      registerCommands(() =>
        unavailable
          ? []
          : [
              {
                id: 'home-pull',
                group: 'Actions',
                title: `Pull ${workspace.name}`,
                subtitle: 'From the worktree it came from',
                icon: '↓',
                run: () => pull({ kind: 'origin' }),
              },
              {
                id: 'home-dry-run',
                group: 'Actions',
                title: `Dry run push of ${workspace.name}`,
                subtitle: 'Show the restored diff only',
                icon: '↑',
                run: () => push({ kind: 'dry-run' }),
              },
              {
                id: 'home-copy-path',
                group: 'Actions',
                title: `Copy path of ${workspace.name}`,
                subtitle: workspace.path,
                icon: '⧉',
                run: () => void copyText(workspace.path, 'Path'),
              },
            ],
      ),
    [workspace.id, workspace.name, workspace.path, unavailable],
  );

  const moved = shown?.sourceMovedFiles ?? 0;
  const pending = toPushCount(workspace);
  const pushHref = `#/ws/${encodeURIComponent(workspace.id)}/push`;
  const pullItems: MenuItem[] = shown
    ? [
        ...pullEntries(shown).map((entry, index) => ({
          label: entry.label,
          hint: entry.hint,
          checked: index === 0,
          onSelect: () => {
            if (entry.target) pull(entry.target);
            else setPrompt('pull-other');
          },
        })),
        { label: 'Add files / commits to this cloak…', onSelect: () => navigate('#/new') },
      ]
    : [];
  const pushItems: MenuItem[] = shown
    ? [
        ...pushEntries(shown).map((entry, index) => ({
          label: entry.label,
          hint: entry.hint,
          checked: index === 0,
          onSelect: () => {
            if (entry.target) push(entry.target);
            else setPrompt(entry.action === 'worktree' ? 'push-other' : 'new-worktree');
          },
        })),
        { label: 'Export restored .patch', onSelect: () => push({ kind: 'patch' }) },
        { label: 'Dry run — show restored diff only', onSelect: () => push({ kind: 'dry-run' }) },
      ]
    : [];
  const base = { repoId: workspace.repoId, id: workspace.id };
  function loadOperation(): Promise<TargetPreview> {
    if (!operation) return Promise.reject(new Error('No operation selected'));
    return operation.direction === 'pull'
      ? api().call('POST /api/v2/workspaces/:repoId/:id/pull', {
          params: base,
          body: { target: operation.target },
        })
      : api().call('POST /api/v2/workspaces/:repoId/:id/push', {
          params: base,
          body: { target: operation.target },
        });
  }
  return (
    <section class="ws-detail" aria-label={`Workspace ${workspace.name}`}>
      <div class="ws-head">
        <div class="ws-title-row">
          <div class="ws-title">
            <div class="ws-title-line">
              <h1 class="mono">{workspace.name}</h1>
              <span class="ws-note">
                group <span class="tone-text">{groupName}</span>
                {shown && shown.profiles.length > 0 && (
                  <>
                    {' '}
                    · profile <span class="tone-accent">{shown.profiles.join(' + ')}</span>
                  </>
                )}
              </span>
            </div>
            <div class="mono ws-path">
              <span class="ws-path-text">{workspace.path}</span>
              <span class="ws-links">
                {!unavailable && <OpenMenu workspace={workspace} />}
                <button
                  type="button"
                  class="ws-link"
                  onClick={() => void copyText(workspace.path, 'Path')}
                >
                  copy path
                </button>
                {!unavailable && (
                  <button type="button" class="ws-link" onClick={() => setPrompt('export')}>
                    export commit
                  </button>
                )}
                <button
                  type="button"
                  class="ws-link ws-link-danger"
                  onClick={() => setPrompt('delete')}
                >
                  delete
                </button>
              </span>
            </div>
          </div>
          <div class="ws-actions">
            <SplitButton
              variant="secondary"
              label={
                <>↓ Pull {moved > 0 && <span class="mono tone-pull ws-small">↓{moved}</span>}</>
              }
              menuLabel="Pull options"
              items={pullItems}
              disabled={unavailable || !shown}
              onClick={() => pull({ kind: 'origin' })}
            />
            <span class="ws-push">
              <SplitButton
                label={<>↑ Push{pending > 0 ? ` ${pending}` : ''}</>}
                menuLabel="Push target options"
                items={pushItems}
                disabled={unavailable || !shown}
                onClick={() => push({ kind: 'origin' })}
              />
            </span>
          </div>
        </div>
        {shown && (
          <>
            <ol class="ws-lineage" aria-label="Lineage">
              {lineageNodes(shown).map((node) => (
                <li key={node.kind} class={`ws-node ws-node-${node.tone}`}>
                  <span class="ws-node-kind">{node.kind}</span>
                  <span class="tone-text">{node.name}</span>
                  <span class={`tone-${node.tone === 'muted' ? '2' : node.tone}`}>{node.ref}</span>
                </li>
              ))}
            </ol>
            <dl class="ws-stats">
              {statCells(shown).map((cell) => (
                <div key={cell.label} class="ws-stat">
                  <dt>{cell.label}</dt>
                  <dd class={`mono tone-${cell.tone}`}>{cell.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
      {failure && (
        <EmptyState
          title="Could not load this workspace"
          action={<Button onClick={() => setTick((value) => value + 1)}>Try again</Button>}
        >
          {failure}
        </EmptyState>
      )}
      {!failure && !shown && (
        <p class="ws-empty" role="status">
          Checking workspace…
        </p>
      )}
      {shown && (
        <div class="ws-panels">
          <PendingPanel detail={shown} />
          <GuardPanel checks={shown.guards} />
          <RequestsPanel detail={shown} onChanged={refresh} />
          <HistoryPanel detail={shown} />
        </div>
      )}
      {operation && (
        <OperationDialog
          key={JSON.stringify(operation)}
          title={operation.title}
          load={loadOperation}
          patchName={`${workspace.name}.patch`}
          reviewHref={operation.direction === 'push' ? pushHref : undefined}
          onClose={() => setOperation(null)}
          onDone={refresh}
        />
      )}
      {shown && (prompt === 'pull-other' || prompt === 'push-other') && (
        <WorktreePicker
          detail={shown}
          direction={prompt === 'pull-other' ? 'pull' : 'push'}
          onClose={() => setPrompt(null)}
          onPick={(target) => {
            setPrompt(null);
            if (target.kind === 'commit' || prompt === 'pull-other') pull(target);
            else push(target);
          }}
        />
      )}
      {prompt === 'new-worktree' && (
        <NewWorktreePrompt
          name={workspace.name}
          onClose={() => setPrompt(null)}
          onSubmit={(branch) => {
            setPrompt(null);
            push({ kind: 'new-worktree', branch });
          }}
        />
      )}
      {prompt === 'delete' && (
        <DeleteDialog workspace={workspace} onClose={() => setPrompt(null)} />
      )}
      {prompt === 'export' && (
        <ExportDialog workspace={workspace} onClose={() => setPrompt(null)} />
      )}
    </section>
  );
}
