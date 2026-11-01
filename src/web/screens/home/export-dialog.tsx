import { useEffect, useState } from 'preact/hooks';
import type { CommitEntry, ExportFile, OverviewWorkspace } from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { sessionInfo } from '../../shell/state.js';
import { Button, Checkbox, Dialog, Field, Mono } from '../../shell/ui/index.js';
import { copyText, downloadText, errorText } from './actions.js';

const pageSize = 20;

/** A source commit as a cloaked diff: commit, then files, then the patch. */
export function ExportDialog({
  workspace,
  onClose,
}: {
  workspace: OverviewWorkspace;
  onClose: () => void;
}) {
  const params = { repoId: workspace.repoId, id: workspace.id };
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [commit, setCommit] = useState<string | null>(null);
  const [files, setFiles] = useState<ExportFile[]>([]);
  const [chosen, setChosen] = useState<number[]>([]);
  const [override, setOverride] = useState(false);
  const [patch, setPatch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canOverride = !sessionInfo.value?.policy.locked.includes('allowExclusionOverride');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }
  const loadPage = (offset: number) =>
    run(async () => {
      const page = await api().call('GET /api/v2/workspaces/:repoId/:id/export/commits', {
        params,
        query: { offset: String(offset) },
      });
      setCommits((current) => (offset ? [...current, ...page] : page));
      setMore(page.length === pageSize);
    });
  const find = (ref: string) =>
    run(async () => {
      setCommits(
        await api().call('GET /api/v2/workspaces/:repoId/:id/export/commits', {
          params,
          query: { ref },
        }),
      );
      setMore(false);
    });
  useEffect(() => {
    void loadPage(0);
    // Loads once for the workspace this dialog was opened on.
  }, []);
  const pick = (sha: string) =>
    run(async () => {
      setCommit(sha);
      setPatch('');
      const result = await api().call('POST /api/v2/workspaces/:repoId/:id/export/files', {
        params,
        body: { commit: sha },
      });
      setFiles(result.files);
      setChosen(
        result.files
          .filter((file) => !file.excluded)
          .map((file) => file.index)
          .slice(0, 100),
      );
    });
  const makePatch = () =>
    run(async () => {
      if (!commit) return;
      const result = await api().call('POST /api/v2/workspaces/:repoId/:id/export/diff', {
        params,
        body: { commit, indexes: chosen, ...(override ? { includeExcluded: true } : {}) },
      });
      setPatch(result.patch);
    });
  const usable = (file: ExportFile) => !file.excluded || override;
  return (
    <Dialog
      title="Export commit as cloaked diff"
      open
      onClose={onClose}
      actions={
        <>
          {patch && (
            <>
              <Button onClick={() => void copyText(patch, 'Patch')}>Copy</Button>
              <Button onClick={() => downloadText(`${workspace.name}.patch`, patch)}>
                Download .patch
              </Button>
            </>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {commit && (
            <Button
              variant="primary"
              disabled={busy || !chosen.length}
              onClick={() => void makePatch()}
            >
              Build diff
            </Button>
          )}
        </>
      }
    >
      {error && (
        <p class="field-error" role="alert">
          {error}
        </p>
      )}
      <form
        class="export-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (search.trim()) void find(search.trim());
          else void loadPage(0);
        }}
      >
        <Field
          label="Find a branch, tag or sha"
          value={search}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
        <Button type="submit" disabled={busy}>
          Find
        </Button>
      </form>
      <ul class="export-list" aria-label="Commits">
        {commits.map((entry) => (
          <li key={entry.sha}>
            <button
              type="button"
              class={`export-row${entry.sha === commit ? ' export-row-on' : ''}`}
              aria-pressed={entry.sha === commit}
              onClick={() => void pick(entry.sha)}
            >
              <Mono muted>{entry.sha.slice(0, 7)}</Mono> <span>{entry.subject}</span>
            </button>
          </li>
        ))}
        {!commits.length && !busy && <li class="export-none">No commits found.</li>}
      </ul>
      {more && (
        <Button
          size="small"
          variant="ghost"
          disabled={busy}
          onClick={() => void loadPage(commits.length)}
        >
          Load older commits
        </Button>
      )}
      {commit && (
        <>
          <h3 class="op-list-title">Files in this commit</h3>
          <div class="export-files">
            {files.map((file) => (
              <Checkbox
                key={file.index}
                disabled={!usable(file)}
                checked={chosen.includes(file.index)}
                onChange={(event) =>
                  setChosen((current) =>
                    event.currentTarget.checked
                      ? [...current, file.index]
                      : current.filter((index) => index !== file.index),
                  )
                }
                label={
                  <span class="mono">
                    {file.path}
                    {file.excluded ? ' · excluded' : ''}
                    {file.added !== null && ` +${file.added} −${file.removed ?? 0}`}
                  </span>
                }
              />
            ))}
          </div>
          {canOverride && files.some((file) => file.excluded) && (
            <Checkbox
              label="Allow excluded files in this export"
              checked={override}
              onChange={(event) => setOverride(event.currentTarget.checked)}
            />
          )}
        </>
      )}
      {patch && (
        <pre class="op-patch" tabIndex={0} aria-label="Cloaked diff">
          {patch}
        </pre>
      )}
    </Dialog>
  );
}
