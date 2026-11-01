import { useEffect, useRef, useState } from 'preact/hooks';
import type { GroupOperationState, OperationPreview } from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { Button, Checkbox, Dialog, Field, toast } from '../../shell/ui/index.js';
import { errorText, refreshOverview, reportError, sleep } from '../home/actions.js';
import { PreviewSummary, needsConfirmation } from '../home/operation-dialog.js';
import type { GroupBulkView, GroupDetailView, GroupOperationView } from '../home/types.js';
import { readRules } from './rules.js';

const stateLabels: Record<GroupOperationState['members'][number]['state'], string> = {
  pending: 'waiting',
  running: 'running…',
  completed: 'done',
  failed: 'failed',
  unattempted: 'skipped',
};

/** Preview, confirm, apply, follow each member, and offer a retry of what did not finish. */
export function BulkDialog({
  group,
  direction,
  selected,
  onClose,
  onDone,
}: {
  group: GroupDetailView;
  direction: 'pull' | 'push';
  selected: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const rules = readRules(group.id, group.rules);
  const askMessage = direction === 'push' && rules.sameCommitMessage;
  const [commitMessage, setCommitMessage] = useState('');
  const [started, setStarted] = useState(!askMessage);
  const [preview, setPreview] = useState<OperationPreview | null>(null);
  const [run, setRun] = useState<GroupOperationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);
  const pending = useRef<string | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (!started) return;
    const body: GroupBulkView = {
      direction,
      revision: group.revision,
      stopOnGuardFailure: rules.stopOnGuardFailure,
      ...(askMessage && commitMessage.trim() ? { commitMessage: commitMessage.trim() } : {}),
      ...(selected.length < group.members.length ? { members: selected } : {}),
    };
    api()
      .call('POST /api/v2/groups/:id/bulk', { params: { id: group.id }, body })
      .then(
        (value) => {
          pending.current = value.operationId;
          if (live.current) setPreview(value);
          else void cancel(value.operationId);
        },
        (cause: unknown) => {
          if (live.current) setError(errorText(cause));
        },
      );
    // Runs once, when the owner starts the review.
  }, [started]);
  function cancel(id: string) {
    return api()
      .call('DELETE /api/v2/group-operations/:id', { params: { id } })
      .catch(() => undefined);
  }
  function close() {
    if (busy) return;
    if (pending.current) void cancel(pending.current);
    pending.current = null;
    onClose();
  }
  async function follow(id: string, first: GroupOperationView) {
    let state = first;
    setRun(state);
    while (state.state === 'running') {
      await sleep(300);
      state = await api().call('GET /api/v2/group-operations/:id', { params: { id } });
      if (live.current) setRun(state);
    }
    return state;
  }
  async function apply(operationId: string, repoIds: string[]) {
    setBusy(true);
    setError(null);
    pending.current = null;
    try {
      // Acknowledgements name exactly this batch, and only what the owner actually confirmed.
      const members = repoIds.map((repoId) => ({
        repoId,
        deletions: confirmed,
        profiles: confirmed,
      }));
      const first: GroupOperationView = await api().call(
        'POST /api/v2/group-operations/:id/apply',
        { params: { id: operationId }, body: { members } },
      );
      const state = await follow(operationId, first);
      if (state.state === 'completed') {
        toast(`${direction === 'pull' ? 'Pull' : 'Push'} complete for ${group.name}`, 'ok');
        refreshOverview().catch(reportError);
        onDone();
        onClose();
        return;
      }
      refreshOverview().catch(reportError);
      onDone();
      setError(state.error ?? `The run ended as ${state.state}`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    if (!run) return;
    const failedId = run.operationId;
    setBusy(true);
    setError(null);
    try {
      const next = await api().call('POST /api/v2/group-operations/:id/retry', {
        params: { id: failedId },
      });
      setRun(null);
      setBusy(false);
      await apply(
        next.operationId,
        next.members.map((member) => member.repoId),
      );
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  }
  const canApply = !run && (preview?.summary.canApply ?? false);
  const blocked = preview ? needsConfirmation(preview) && !confirmed : true;
  const title = `${direction === 'pull' ? 'Pull' : 'Push'} all in ${group.name}`;
  return (
    <Dialog
      title={title}
      open
      onClose={close}
      actions={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {canApply || !started ? 'Cancel' : 'Close'}
          </Button>
          {!started && (
            <Button variant="primary" onClick={() => setStarted(true)}>
              Preview
            </Button>
          )}
          {run?.state === 'failed' && (
            <Button variant="primary" disabled={busy} onClick={() => void retry()}>
              Retry unfinished
            </Button>
          )}
          {canApply && preview && (
            <Button
              variant="primary"
              disabled={busy || blocked}
              onClick={() => void apply(preview.operationId, selected)}
            >
              Apply
            </Button>
          )}
        </>
      }
    >
      {!started && (
        <Field
          label="Commit message for every repo"
          hint="Leave empty to write files without committing."
          value={commitMessage}
          onInput={(event) => setCommitMessage(event.currentTarget.value)}
        />
      )}
      {started && !preview && !error && <p role="status">Preparing preview…</p>}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      {preview && !run && <PreviewSummary preview={preview} />}
      {preview && !run && !preview.summary.canApply && rules.stopOnGuardFailure && (
        <p class="tone-blocked">A guard check failed, so nothing will run.</p>
      )}
      {canApply && preview && needsConfirmation(preview) && (
        <Checkbox
          label="I confirm the listed deletions and profile changes"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.currentTarget.checked)}
        />
      )}
      {run && (
        <ul class="grp-run" aria-label="Member progress">
          {run.members.map((member) => {
            const row = group.members.find((item) => item.repoId === member.repoId);
            return (
              <li key={member.repoId} data-state={member.state}>
                <span class="mono">{row?.folder ?? member.repoId}</span>{' '}
                <span>{stateLabels[member.state]}</span>
                {member.error && <span class="tone-blocked"> · {member.error}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
