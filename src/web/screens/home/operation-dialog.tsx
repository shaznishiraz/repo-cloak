import { useEffect, useRef, useState } from 'preact/hooks';
import type { OperationPreview, OperationState } from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { Button, Checkbox, Dialog, Mono, toast } from '../../shell/ui/index.js';
import { downloadText, errorText, sleep } from './actions.js';
import type { TargetPreview } from './types.js';

function PathList({ title, paths, tone }: { title: string; paths: string[]; tone?: string }) {
  if (!paths.length) return null;
  return (
    <div class="op-list">
      <h3 class={`op-list-title${tone ? ` tone-${tone}` : ''}`}>
        {title} <span class="op-count">{paths.length}</span>
      </h3>
      <ul>
        {paths.slice(0, 200).map((path) => (
          <li key={path} class="mono">
            {path}
          </li>
        ))}
        {paths.length > 200 && <li>and {paths.length - 200} more</li>}
      </ul>
    </div>
  );
}

/** What a preview would do. Shared by single workspace operations and group bulk runs. */
export function PreviewSummary({ preview }: { preview: OperationPreview }) {
  const { summary } = preview;
  const nothing =
    !summary.writes.length &&
    !summary.deletes.length &&
    !summary.conflicts.length &&
    !summary.profileChanges.length;
  return (
    <div class="op-summary">
      <p class="op-route">
        <Mono muted>{summary.source.path}</Mono> → <Mono>{summary.destination.path}</Mono>
        {summary.destination.branch && <Mono muted> · {summary.destination.branch}</Mono>}
      </p>
      {nothing && <p>Nothing to change.</p>}
      <PathList title="Conflicts" paths={summary.conflicts} tone="blocked" />
      <PathList title="Writes" paths={summary.writes} />
      <PathList title="Deletes" paths={summary.deletes} tone="blocked" />
      <PathList title="Profile changes" paths={summary.profileChanges} tone="push" />
      <PathList title="Warnings" paths={summary.warnings} tone="push" />
    </div>
  );
}

export function needsConfirmation({ summary }: OperationPreview) {
  return summary.deletes.length > 0 || summary.profileChanges.length > 0;
}

/** Preview first, then apply on request and follow the operation until it settles. */
export function OperationDialog({
  title,
  load,
  patchName,
  reviewHref,
  onClose,
  onDone,
}: {
  title: string;
  load: () => Promise<TargetPreview>;
  patchName?: string | undefined;
  reviewHref?: string | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<TargetPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [applying, setApplying] = useState(false);
  const live = useRef(true);
  // The latest preview for cleanup: an abandoned one should not hold a pending slot.
  const pending = useRef<string | null>(null);
  useEffect(() => {
    live.current = true;
    load().then(
      (value) => {
        if (value.summary.canApply) pending.current = value.operationId;
        if (live.current) setPreview(value);
        else void cancel(value.operationId);
      },
      (cause: unknown) => {
        if (live.current) setError(errorText(cause));
      },
    );
    return () => {
      live.current = false;
    };
    // The dialog is mounted per request, so `load` is fixed for its lifetime.
  }, []);
  function cancel(id: string) {
    return api()
      .call('DELETE /api/v2/operations/:id', { params: { id } })
      .catch(() => undefined);
  }
  function close() {
    if (applying) return;
    if (pending.current) void cancel(pending.current);
    pending.current = null;
    onClose();
  }
  async function apply() {
    if (!preview) return;
    setApplying(true);
    setError(null);
    const id = preview.operationId;
    pending.current = null;
    try {
      const { summary } = preview;
      let state: OperationState = await api().call('POST /api/v2/operations/:id/apply', {
        params: { id },
        body: {
          ...(summary.deletes.length ? { deletions: true } : {}),
          ...(summary.profileChanges.length ? { profiles: true } : {}),
        },
      });
      while (state.state === 'running' || state.state === 'pending') {
        await sleep(250);
        state = await api().call('GET /api/v2/operations/:id', { params: { id } });
      }
      if (state.state !== 'completed')
        throw new Error(state.error ?? `The operation ended as ${state.state}`);
      const count = (state.result?.writes.length ?? 0) + (state.result?.deletes.length ?? 0);
      toast(`${title} complete · ${count} ${count === 1 ? 'file' : 'files'}`, 'ok');
      onDone();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setApplying(false);
    }
  }
  const canApply = preview?.summary.canApply ?? false;
  const blockedByConfirm = preview ? needsConfirmation(preview) && !confirmed : true;
  const patch = preview?.patch;
  return (
    <Dialog
      title={title}
      open
      onClose={close}
      actions={
        <>
          {reviewHref && preview && !canApply && patch === undefined && (
            <a class="btn btn-secondary" href={reviewHref} onClick={close}>
              Review push →
            </a>
          )}
          {patch && patchName && (
            <Button variant="secondary" onClick={() => downloadText(patchName, patch)}>
              Download .patch
            </Button>
          )}
          <Button variant="ghost" onClick={close} disabled={applying}>
            {canApply ? 'Cancel' : 'Close'}
          </Button>
          {canApply && (
            <Button
              variant="primary"
              onClick={() => void apply()}
              disabled={applying || blockedByConfirm}
            >
              {applying ? 'Applying…' : 'Apply'}
            </Button>
          )}
        </>
      }
    >
      {!preview && !error && <p role="status">Preparing preview…</p>}
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      {preview && <PreviewSummary preview={preview} />}
      {preview && patch !== undefined && (
        <pre class="op-patch" tabIndex={0} aria-label="Restored diff">
          {patch || 'No restored changes.'}
        </pre>
      )}
      {preview && canApply && needsConfirmation(preview) && (
        <Checkbox
          label="I confirm the listed deletions and profile changes"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.currentTarget.checked)}
        />
      )}
    </Dialog>
  );
}
