import { useSignal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/client.js';
import type {
  DiffLine,
  GuardCheck,
  OperationResult,
  PushBackup,
  PushReview,
  WorktreeOption,
} from '../../api/contracts.js';
import { registerCommands } from '../../shell/commands.js';
import type { Command } from '../../shell/commands.js';
import { api } from '../../shell/load.js';
import { overview } from '../../shell/state.js';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Row,
  RowList,
  buttonClass,
  toast,
} from '../../shell/ui/index.js';
import { PushAside } from './aside.js';
import type { PushForm } from './aside.js';
import { DiffPane } from './diff.js';
import type { DiffMode } from './diff.js';
import {
  baseName,
  count,
  directoryOf,
  flagText,
  hasConflict,
  mergeNotes,
  statusLetter,
  targetNote,
  targetOptions,
  totals,
} from './model.js';
import './push.css';

const pollMs = 400;
type Confirm = 'overwrite' | 'deletes' | 'undo' | 'new-worktree' | null;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'The request failed';
}
function isStale(error: unknown) {
  return error instanceof ApiError && ['stale', 'expired', 'unknown'].includes(error.code ?? '');
}

/** The shell sets the overview after the session starts, but a render must never throw. */
function sessionClient() {
  try {
    return api();
  } catch {
    return undefined;
  }
}

export function PushScreen({ workspaceId }: { workspaceId: string }) {
  const data = overview.value;
  const workspace = data?.workspaces.find((item) => item.id === workspaceId);
  const repoId = workspace?.repoId;
  const client = data ? sessionClient() : undefined;
  const ids = useMemo(
    () => (repoId ? { repoId, id: workspaceId } : undefined),
    [repoId, workspaceId],
  );

  const [worktrees, setWorktrees] = useState<WorktreeOption[]>([]);
  const [targetValue, setTargetValue] = useState('origin');
  const [createdBranch, setCreatedBranch] = useState<string>();
  const [review, setReview] = useState<PushReview>();
  const [reviewError, setReviewError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [lines, setLines] = useState<DiffLine[]>();
  const [diffError, setDiffError] = useState<string>();
  const [mode, setMode] = useState<DiffMode>('both');
  const [mergeMode, setMergeMode] = useState<'merge' | 'overwrite'>('merge');
  const [form, setForm] = useState<PushForm>({
    mode: 'stage',
    commitMessage: '',
    repull: true,
    includeGroupMembers: false,
  });
  const [messageError, setMessageError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [backups, setBackups] = useState<PushBackup[]>([]);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [branch, setBranch] = useState('');
  const [result, setResult] = useState<{ result: OperationResult; failed?: string }>();
  const [failure, setFailure] = useState<string>();
  const [reviewCount, setReviewCount] = useState(0);
  const sequence = useRef(0);

  const options = useMemo(
    () => (workspace ? targetOptions(workspace, worktrees, createdBranch) : []),
    // The overview refreshes in the background; only the lineage changes these labels.
    [workspace?.lineage.worktree?.path, workspace?.lineage.repo.path, worktrees, createdBranch],
  );
  const option = options.find((item) => item.value === targetValue) ?? options[0];
  const target = option?.target;
  const targetKey = target ? JSON.stringify(target) : undefined;
  const rereview = () => setReviewCount((value) => value + 1);

  useEffect(() => {
    if (!client || !ids) return;
    client
      .call('GET /api/v2/worktrees/:repoId', { params: { repoId: ids.repoId } })
      .then((value) => setWorktrees(value.worktrees))
      // Without the list the picker still offers the pulled-from, main and new targets.
      .catch(() => setWorktrees([]));
  }, [client, ids]);

  async function loadBackups() {
    if (!client || !ids) return;
    try {
      const value = await client.call('GET /api/v2/push/:repoId/:id/backups', { params: ids });
      setBackups(value.backups);
    } catch {
      setBackups([]);
    }
  }
  useEffect(() => void loadBackups(), [ids]);

  useEffect(() => {
    if (!client || !ids || !target) return;
    const at = ++sequence.current;
    setLoading(true);
    setReviewError(undefined);
    setMergeMode('merge');
    client
      .call('POST /api/v2/push/:repoId/:id/review', { params: ids, body: { target } })
      .then((value) => {
        if (at !== sequence.current) return;
        setReview(value);
        setSelected((current) =>
          value.files.some((file) => file.path === current) ? current : value.files[0]?.path,
        );
      })
      .catch((error: unknown) => {
        if (at !== sequence.current) return;
        setReview(undefined);
        setReviewError(errorText(error));
      })
      .finally(() => {
        if (at === sequence.current) setLoading(false);
      });
  }, [client, ids, targetKey, reviewCount]);

  useEffect(() => {
    setLines(undefined);
    setDiffError(undefined);
    if (!client || !ids || !selected) return;
    let live = true;
    client
      .call('GET /api/v2/push/:repoId/:id/diff', { params: ids, query: { path: selected } })
      .then((value) => {
        if (live) setLines(value.lines);
      })
      .catch((error: unknown) => {
        if (live) setDiffError(errorText(error));
      });
    return () => {
      live = false;
    };
  }, [client, ids, selected, reviewCount]);

  async function push() {
    if (!client || !ids || !review?.operationId) return;
    setBusy(true);
    setFailure(undefined);
    setMessageError(undefined);
    setResult(undefined);
    try {
      const message = form.commitMessage.trim();
      let state = await client.call('POST /api/v2/push/:repoId/:id/apply', {
        params: ids,
        body: {
          operationId: review.operationId,
          mode: form.mode,
          ...(form.mode === 'commit' ? { commitMessage: message } : {}),
          repull: form.repull,
          includeGroupMembers: form.includeGroupMembers,
          mergeMode,
        },
      });
      while (state.state === 'pending' || state.state === 'running') {
        await new Promise((done) => setTimeout(done, pollMs));
        state = await client.call('GET /api/v2/operations/:id', {
          params: { id: state.operationId },
        });
      }
      if (state.state === 'completed' && state.result) {
        const { writes, deletes } = state.result;
        toast(`Pushed ${count(writes.length + deletes.length, 'file')}`, 'ok');
        setResult({ result: state.result });
      } else if (state.code === 'stale') {
        setFailure(`Files changed after this review, so nothing was written. Review it again.`);
      } else {
        setFailure(state.error ?? 'The push failed');
      }
    } catch (error) {
      const text = errorText(error);
      if (/commit message/i.test(text)) setMessageError(text);
      else if (isStale(error))
        setFailure('This review ended, so nothing was written. Review it again.');
      else setFailure(text);
    } finally {
      setBusy(false);
      setForm((current) => ({ ...current, includeGroupMembers: false }));
      rereview();
      void loadBackups();
    }
  }
  async function undo() {
    const latest = backups[0];
    if (!client || !ids || !latest) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const value = await client.call('POST /api/v2/push/:repoId/:id/backups/:backupId/undo', {
        params: { ...ids, backupId: latest.id },
      });
      toast(`Restored ${count(value.restored, 'file')} from the backup`, 'ok');
      setResult(undefined);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
      rereview();
      void loadBackups();
    }
  }

  const files = review?.files ?? [];
  const deletes = files.filter((file) => file.status === 'deleted').length;
  const file = files.find((item) => item.path === selected);
  const sum = totals(files);
  const members = workspace?.groupId
    ? (data?.workspaces.filter(
        (item) => item.groupId === workspace.groupId && item.id !== workspaceId,
      ) ?? [])
    : [];
  const groupName = data?.groups.find((group) => group.id === workspace?.groupId)?.name;
  const note: GuardCheck | undefined = review && targetNote(review);
  const notes = review ? mergeNotes(review) : [];
  const conflicted = !!review && hasConflict(review);
  const readOnly = target?.kind === 'dry-run';
  let blockedBecause: string | undefined;
  if (loading) blockedBecause = 'Checking…';
  else if (readOnly) blockedBecause = 'Dry run: nothing will be written';
  else if (!review) blockedBecause = 'This push could not be reviewed';
  else if (!files.length) blockedBecause = 'Nothing to push';
  else if (!review.canApply || !review.operationId) blockedBecause = 'Fix the blocked checks first';
  else if (conflicted && mergeMode === 'merge')
    blockedBecause = 'Pull first, or choose to overwrite the overlapping files';
  else if (form.mode === 'commit' && !form.commitMessage.trim())
    blockedBecause = 'Enter a commit message';
  const pushLabel = `Push ${count(files.length, 'file')} to ${option?.short ?? 'the source'}`;

  function requestPush() {
    if (blockedBecause !== undefined) return;
    if (deletes) setConfirm('deletes');
    else void push();
  }

  // A signal, because the palette's list is computed and must see these titles change.
  const live = useSignal<Command[]>([]);
  const list: Command[] = workspace
    ? [
        {
          id: 'push.go',
          group: 'Push review',
          title: pushLabel,
          subtitle: workspace.name,
          icon: '↑',
          keywords: ['push', 'restore', 'source'],
          run: requestPush,
        },
        {
          id: 'push.recheck',
          group: 'Push review',
          title: 'Review this push again',
          icon: '↻',
          keywords: ['recheck', 'refresh'],
          run: rereview,
        },
        {
          id: 'push.mode',
          group: 'Push review',
          title: mode === 'both' ? 'Show restored diff only' : 'Show cloak beside restored',
          icon: '⇄',
          keywords: ['diff', 'toggle'],
          run: () => setMode(mode === 'both' ? 'restored' : 'both'),
        },
        ...(backups[0]
          ? [
              {
                id: 'push.undo',
                group: 'Push review',
                title: 'Undo the last push',
                icon: '↶',
                keywords: ['backup', 'restore'],
                run: () => setConfirm('undo'),
              },
            ]
          : []),
      ]
    : [];
  useEffect(() => {
    live.value = list;
  });
  useEffect(() => registerCommands(() => live.value), [live]);

  if (!data)
    return (
      <main class="screen push" aria-label="Push review">
        <div class="push-loading">Loading…</div>
      </main>
    );
  if (!workspace)
    return (
      <main class="screen push" aria-label="Push review">
        <EmptyState
          title="Workspace not found"
          action={
            <a class={buttonClass('secondary')} href="#/">
              Back to workspaces
            </a>
          }
        >
          This cloak is not registered any more.
        </EmptyState>
      </main>
    );

  return (
    <main class="screen push" aria-label="Push review">
      <header class="push-head">
        <a class="push-crumb" href={`#/ws/${encodeURIComponent(workspaceId)}`}>
          {workspace.name}
        </a>
        <span class="push-sep">/</span>
        <h1 class="push-title">Push</h1>
        <div class="push-route">
          <span class="push-chip">cloak · {count(files.length, 'change')}</span>
          <span class="push-sep">→</span>
          <label class="push-into">
            <span>into</span>
            <select
              value={targetValue}
              disabled={busy}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === 'new') {
                  event.currentTarget.value = targetValue;
                  setBranch('');
                  setConfirm('new-worktree');
                } else setTargetValue(value);
              }}
            >
              {options.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {note && (
          <span class={`push-status${note.state === 'warning' ? ' push-status-warning' : ''}`}>
            {note.title}
            {note.detail ? ` · ${note.detail}` : ''}
          </span>
        )}
      </header>
      <div class="push-body">
        <section class="push-files" aria-label="Files">
          <div class="push-files-head">
            <span>{count(files.length, 'file')}</span>
            <span class="push-sum">
              <span class="push-plus">+{sum.additions}</span>{' '}
              <span class="push-minus">−{sum.deletions}</span>
            </span>
          </div>
          <RowList label="Changed files">
            {files.map((item) => {
              const flag = flagText(item);
              return (
                <Row
                  key={item.path}
                  selected={item.path === selected}
                  onSelect={() => setSelected(item.path)}
                >
                  <span class={`push-st push-st-${item.status}`}>{statusLetter[item.status]}</span>
                  <span class="push-file">
                    <span class="push-file-name">{baseName(item.restoredPath)}</span>
                    <span class="push-file-dir">
                      {directoryOf(item.restoredPath) || './'}
                      {item.status === 'added' ? ' · new' : ''}
                    </span>
                    <span class={`push-flag push-tone-${flag.tone}`}>{flag.text}</span>
                  </span>
                </Row>
              );
            })}
          </RowList>
        </section>
        <section class="push-main" aria-label="Changes">
          {reviewError && (
            <div class="push-result" role="alert">
              <span class="push-result-title">This push could not be reviewed</span>
              <span class="push-note-detail">{reviewError}</span>
            </div>
          )}
          {failure && (
            <div class="push-note push-note-blocked" role="alert">
              <span class="push-note-mark">×</span>
              <div class="push-note-text">
                <div class="push-note-title">Push did not finish</div>
                <div class="push-note-detail">{failure}</div>
              </div>
            </div>
          )}
          {result && (
            <div class="push-result" role="status">
              <span class="push-result-title">
                Pushed {count(result.result.writes.length + result.result.deletes.length, 'file')}
              </span>
              {result.result.warnings.map((warning) => (
                <span key={warning} class="push-note-detail">
                  {warning}
                </span>
              ))}
            </div>
          )}
          {review && !files.length && !loading ? (
            <EmptyState
              title="Nothing to push"
              action={
                <a
                  class={buttonClass('secondary')}
                  href={`#/ws/${encodeURIComponent(workspaceId)}`}
                >
                  Back to workspace
                </a>
              }
            >
              The cloak matches what it last synchronized.
            </EmptyState>
          ) : (
            <DiffPane file={file} lines={lines} error={diffError} mode={mode} onMode={setMode} />
          )}
          <div class="push-notes">
            {notes.map((item) => (
              <div
                key={item.id}
                class={`push-note${item.state === 'blocked' ? ' push-note-blocked' : ''}`}
                data-note={item.id}
              >
                <span class="push-note-mark" aria-hidden="true">
                  {item.state === 'blocked' ? '×' : '↓'}
                </span>
                <div class="push-note-text">
                  <div class="push-note-title">{item.title}</div>
                  <div class="push-note-detail">{item.detail}</div>
                </div>
                <div class="push-note-actions">
                  <Button
                    size="small"
                    disabled={item.state === 'blocked'}
                    aria-pressed={item.state !== 'blocked' && mergeMode === 'merge'}
                    onClick={() => setMergeMode('merge')}
                  >
                    Merge (recommended)
                  </Button>
                  <a
                    class={buttonClass('ghost', 'small')}
                    href={`#/ws/${encodeURIComponent(workspaceId)}`}
                  >
                    Pull first
                  </a>
                  <Button
                    size="small"
                    variant="ghost"
                    aria-pressed={mergeMode === 'overwrite'}
                    onClick={() => setConfirm('overwrite')}
                  >
                    Overwrite
                  </Button>
                </div>
              </div>
            ))}
            {notes.length > 0 && <div class="push-notes-end" />}
          </div>
        </section>
        <PushAside
          review={review}
          form={form}
          onForm={(change) => {
            setMessageError(undefined);
            setForm((current) => ({ ...current, ...change }));
          }}
          fileCount={files.length}
          groupMembers={
            members.length && groupName
              ? { names: members.map((item) => item.name), group: groupName }
              : undefined
          }
          pushLabel={pushLabel}
          blockedBecause={blockedBecause}
          busy={busy}
          onPush={requestPush}
          backup={backups[0]}
          onUndo={() => setConfirm('undo')}
          message={messageError}
        />
      </div>
      <Dialog
        title="Overwrite upstream changes?"
        open={confirm === 'overwrite'}
        onClose={() => setConfirm(null)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep merging
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setMergeMode('overwrite');
                setConfirm(null);
              }}
            >
              Overwrite source files
            </Button>
          </>
        }
      >
        Files that changed in the source get your version as it stands, dropping the upstream edits
        from the working tree. A backup is kept for 7 days.
      </Dialog>
      <Dialog
        title={`Delete ${count(deletes, 'file')} from the source?`}
        open={confirm === 'deletes'}
        onClose={() => setConfirm(null)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(null);
                void push();
              }}
            >
              Delete and push
            </Button>
          </>
        }
      >
        <ul class="mono">
          {files
            .filter((item) => item.status === 'deleted')
            .map((item) => (
              <li key={item.path}>{item.restoredPath}</li>
            ))}
        </ul>
      </Dialog>
      <Dialog
        title="Undo the last push?"
        open={confirm === 'undo'}
        onClose={() => setConfirm(null)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirm(null);
                void undo();
              }}
            >
              Restore from backup
            </Button>
          </>
        }
      >
        {backups[0] ? count(backups[0].files, 'file') : 'Files'} go back to how they were, and your
        cloak edits show as pending again. A commit made by that push stays in history, and the old
        content appears as an uncommitted change.
      </Dialog>
      <Dialog
        title="New worktree from main"
        open={confirm === 'new-worktree'}
        onClose={() => setConfirm(null)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!branch.trim()}
              onClick={() => {
                const name = branch.trim();
                setCreatedBranch(name);
                setTargetValue(`new:${name}`);
                setConfirm(null);
              }}
            >
              Review
            </Button>
          </>
        }
      >
        <Field
          label="Branch name"
          value={branch}
          onInput={(event) => setBranch(event.currentTarget.value)}
        />
      </Dialog>
    </main>
  );
}
