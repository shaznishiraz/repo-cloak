import { useEffect, useState } from 'preact/hooks';
import type { PostCheckView } from '../../api/contracts.js';
import type { api } from '../../shell/load.js';
import { Button, Dialog, Field } from '../../shell/ui/index.js';

const pollMs = 1000;
const verdict = {
  running: 'Running…',
  passed: 'Passed',
  failed: 'Failed',
  'timed-out': 'Timed out',
};

/** Never runs by itself: the button works only after a push, and its dialog must be accepted. */
export function PostCheck({
  client,
  ids,
  pushes,
}: {
  client: ReturnType<typeof api>;
  ids: { repoId: string; id: string };
  /** Changes after each push or undo, when the server's answer to "can this run?" may change. */
  pushes: number;
}) {
  const [view, setView] = useState<PostCheckView>();
  const [command, setCommand] = useState('');
  const [seconds, setSeconds] = useState('600');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const show = (value: PostCheckView) => {
    setView(value);
    setCommand(value.command ?? '');
    setSeconds(String(value.timeoutSeconds));
  };
  const refresh = () => client.call('GET /api/v2/push/:repoId/:id/post-check', { params: ids });
  useEffect(() => {
    let live = true;
    refresh()
      .then((value) => live && value && show(value))
      .catch(() => live && setView(undefined));
    return () => {
      live = false;
    };
  }, [client, ids, pushes]);
  const run = view?.run;
  useEffect(() => {
    if (run?.state !== 'running') return;
    const timer = setTimeout(() => {
      refresh()
        .then(setView)
        .catch(() => setError('Could not read the post-check'));
    }, pollMs);
    return () => clearTimeout(timer);
  }, [view]);
  const trimmed = command.trim();
  const dirty =
    !!view && (trimmed !== (view.command ?? '') || seconds !== String(view.timeoutSeconds));
  async function attempt(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request failed');
    }
  }
  const save = () =>
    attempt(async () =>
      show(
        await client.call('PUT /api/v2/push/:repoId/:id/post-check', {
          params: ids,
          body: { command: trimmed || null, timeoutSeconds: Number(seconds) },
        }),
      ),
    );
  const start = () =>
    attempt(async () => {
      setConfirming(false);
      await client.call('POST /api/v2/push/:repoId/:id/post-check/run', {
        params: ids,
        body: { confirmed: true, command: view?.command ?? '' },
      });
      setView(await refresh());
    });
  if (!view) return null;
  return (
    <div class="push-block push-post-check">
      <div class="push-block-title">Post-check</div>
      <Field
        label="Command, run only when you click"
        value={command}
        onInput={(event) => setCommand(event.currentTarget.value)}
      />
      <Field
        label="Time limit (seconds)"
        type="number"
        min={1}
        max={3600}
        value={seconds}
        onInput={(event) => setSeconds(event.currentTarget.value)}
      />
      <div class="push-post-actions">
        <Button size="small" disabled={!dirty} onClick={() => void save()}>
          Save
        </Button>
        <Button
          size="small"
          variant="secondary"
          disabled={!view.canRun || dirty || run?.state === 'running'}
          onClick={() => setConfirming(true)}
        >
          Run post-check
        </Button>
      </div>
      {!view.canRun && view.command && <span class="push-meta">Available after a push.</span>}
      {error && (
        <span class="field-error" role="alert">
          {error}
        </span>
      )}
      {run && (
        <div role="status">
          <span class="push-post-state" data-state={run.state}>
            {verdict[run.state]}
            {run.exitCode !== null && run.state === 'failed' ? ` · exit ${run.exitCode}` : ''}
            {run.truncated ? ' · last 256 KB' : ''}
          </span>
          {!!run.output && <pre class="push-output">{run.output}</pre>}
        </div>
      )}
      <Dialog
        title="Run this on agent-edited code?"
        open={confirming}
        onClose={() => setConfirming(false)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void start()}>
              Run it
            </Button>
          </>
        }
      >
        <p class="mono">{view.command}</p>
        <p>
          This runs in the target worktree, on code an agent edited. It runs as you and is not
          sandboxed, so that code can read or change anything your account can, including files in
          your repo-cloak store. Only the session token and other environment variables are held
          back.
        </p>
      </Dialog>
    </div>
  );
}
