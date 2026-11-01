import { useEffect, useState } from 'preact/hooks';
import type { KnownRepo, KnownWorktree, RepoDetail } from '../../api/contracts.js';
import { registerCommands } from '../../shell/commands.js';
import { api } from '../../shell/load.js';
import { overview } from '../../shell/state.js';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Panel,
  buttonClass,
  toast,
} from '../../shell/ui/index.js';
import { FolderPicker } from '../../shell/folder-picker.js';
import { LoadError, ago, errorText, useLoad } from './shared.js';

function abLabel(tree: KnownWorktree) {
  return tree.ahead || tree.behind ? `↑${tree.ahead} ↓${tree.behind}` : 'up to date';
}

/** Linked worktrees usually sit under the repo, and the tail is the part that tells them apart. */
export function treeLabel(path: string, repoPath: string) {
  return path.startsWith(`${repoPath}/`) ? path.slice(repoPath.length + 1) : path;
}

function AddRepoDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (repo: KnownRepo) => void;
}) {
  const [path, setPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string>();
  async function add() {
    try {
      onAdded(await api().call('POST /api/v2/repos', { body: { path: path.trim() } }));
      setPath('');
      setError(undefined);
      setBrowsing(false);
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  return (
    <Dialog
      title="Add repo"
      open={open}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!path.trim()} onClick={() => void add()}>
            Add repo
          </Button>
        </>
      }
    >
      <Field
        label="Repository folder"
        value={path}
        error={error}
        onInput={(event) => setPath(event.currentTarget.value)}
      />
      <div class="adm-flex">
        <Button size="small" onClick={() => setBrowsing(!browsing)}>
          {browsing ? 'Hide folders' : 'Browse'}
        </Button>
      </div>
      {browsing && (
        <FolderPicker
          inline
          initial={path.trim()}
          onPick={(picked) => {
            setPath(picked);
            setBrowsing(false);
          }}
        />
      )}
    </Dialog>
  );
}

function ExclusionsDialog({
  detail,
  locked,
  onClose,
  onSaved,
}: {
  detail: RepoDetail;
  locked: string[];
  onClose: () => void;
  onSaved: (detail: RepoDetail) => void;
}) {
  const own = detail.rules.exclude.filter((pattern) => !locked.includes(pattern));
  const [text, setText] = useState(own.join('\n'));
  const [error, setError] = useState<string>();
  async function save() {
    try {
      onSaved(
        await api().call('PUT /api/v2/repos/:id', {
          params: { id: detail.repo.id },
          body: {
            rules: {
              ...detail.rules,
              exclude: text
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            },
          },
        }),
      );
    } catch (failure) {
      setError(errorText(failure));
    }
  }
  return (
    <Dialog
      title="Extra exclusions"
      open
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save exclusions
          </Button>
        </>
      }
    >
      <Field
        label="One pattern per line"
        error={error}
        hint="Files matching these never leave this repo, whatever the profile says."
        control={(props) => (
          <textarea
            {...props}
            class="adm-area"
            value={text}
            onInput={(event) => setText(event.currentTarget.value)}
          />
        )}
      />
      {locked.length > 0 && <p class="adm-note">Also locked by org policy: {locked.join(', ')}</p>}
    </Dialog>
  );
}

function RepoPanel({
  detail,
  locked,
  onChanged,
  onForget,
}: {
  detail: RepoDetail;
  locked: string[];
  onChanged: (detail: RepoDetail) => void;
  onForget: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const { repo, worktrees, rules, exposure } = detail;
  return (
    <>
      <div class="adm-flex">
        <div class="adm-grow">
          <h2 class="adm-h1">{repo.name}</h2>
          <div class={repo.missing ? 'adm-meta-mono adm-gone' : 'adm-meta-mono'}>
            {repo.path}
            {repo.missing && ' — not found'}
          </div>
        </div>
        <a class={buttonClass('secondary', 'small')} href="#/profiles">
          Repo profile
        </a>
        <Button size="small" onClick={onForget}>
          Forget repo
        </Button>
      </div>
      <Panel
        title={
          <>
            Worktrees <span class="adm-meta">from git worktree list · refreshed on open</span>
          </>
        }
      >
        {worktrees.length === 0 && (
          <p class="adm-note adm-pad">
            {repo.missing ? 'The repository folder is gone.' : 'No worktrees found.'}
          </p>
        )}
        {worktrees.map((tree) => (
          <div key={tree.path} class="adm-tree">
            <span class="adm-grow">
              <span class="adm-mono-cut" title={tree.path}>
                {treeLabel(tree.path, repo.path)}
              </span>
              <span class="adm-meta">{tree.isMain ? 'main checkout' : 'linked worktree'}</span>
            </span>
            <span class="adm-mono-cut adm-branch">{tree.branch ?? 'detached'}</span>
            <span class="adm-meta-mono">{abLabel(tree)}</span>
            <span class={`adm-mono-cut${tree.workspace ? ' adm-cloak' : ' adm-meta'}`}>
              {tree.workspace?.name ?? 'no cloak'}
            </span>
            {tree.workspace ? (
              <a
                class={buttonClass('secondary', 'small')}
                href={`#/ws/${encodeURIComponent(tree.workspace.id)}`}
              >
                Open
              </a>
            ) : (
              <a
                class={buttonClass('secondary', 'small')}
                href={`#/new?${new URLSearchParams({ repo: repo.id, worktree: tree.path })}`}
              >
                Cloak
              </a>
            )}
          </div>
        ))}
      </Panel>
      <div class="adm-cols">
        <Panel
          title="Repo rules"
          actions={
            <Button size="small" onClick={() => setEditing(true)}>
              Edit exclusions
            </Button>
          }
        >
          <dl class="adm-facts adm-pad">
            <dt>Default profiles</dt>
            <dd>
              {rules.defaultProfiles.join(', ') || 'none'}{' '}
              <span class="adm-meta">(from the last cloak)</span>
            </dd>
            <dt>Extra exclusions</dt>
            <dd>
              {rules.exclude.length ? (
                <span class="adm-chips">
                  {rules.exclude.map((pattern) => (
                    <span
                      key={pattern}
                      class={`adm-chip${locked.includes(pattern) ? ' adm-chip-locked' : ''}`}
                    >
                      {pattern}
                      {locked.includes(pattern) && ' · policy'}
                    </span>
                  ))}
                </span>
              ) : (
                'none'
              )}
            </dd>
            <dt>Allowed roots</dt>
            <dd class="adm-meta">Not enforced yet: anything not excluded can be pulled.</dd>
          </dl>
        </Panel>
        <Panel title="Exposure so far">
          <div class="adm-stats adm-pad">
            <div>
              <div class="adm-stat">{exposure.filesOut}</div>
              <div class="adm-meta">files cloaked</div>
            </div>
            <div>
              <div class="adm-stat">{exposure.workspaces}</div>
              <div class="adm-meta">cloaks</div>
            </div>
          </div>
        </Panel>
      </div>
      {editing && (
        <ExclusionsDialog
          detail={detail}
          locked={locked}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false);
            onChanged(next);
            toast('Exclusions saved', 'ok');
          }}
        />
      )}
    </>
  );
}

export function ReposScreen() {
  const list = useLoad(() => api().call('GET /api/v2/repos'), []);
  const settings = useLoad(() => api().call('GET /api/v2/settings'), []);
  const [selected, setSelected] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const repos = [...(list.data?.repos ?? [])].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name),
  );
  const launch = overview.value?.launch;
  const launchRepo = launch && 'repoId' in launch ? launch.repoId : undefined;
  const active =
    repos.find((repo) => repo.id === selected) ??
    repos.find((repo) => repo.id === launchRepo) ??
    repos[0];
  const activeId = active?.id;
  const detail = useLoad(
    () =>
      activeId
        ? api().call('GET /api/v2/repos/:id', { params: { id: activeId } })
        : Promise.resolve(null),
    [activeId],
  );
  useEffect(
    () =>
      registerCommands(() => [
        {
          id: 'repos-add',
          group: 'Actions',
          title: 'Add repo',
          icon: '+',
          keywords: ['repository'],
          run: () => setAdding(true),
        },
      ]),
    [],
  );
  async function pin(repo: KnownRepo) {
    try {
      const next = await api().call('PUT /api/v2/repos/:id', {
        params: { id: repo.id },
        body: { pinned: !repo.pinned },
      });
      if (repo.id === activeId) detail.set(next);
      await list.reload();
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }
  async function forget() {
    if (!activeId) return;
    try {
      await api().call('DELETE /api/v2/repos/:id', { params: { id: activeId } });
      setForgetting(false);
      setSelected(undefined);
      toast('Repo forgotten. Its source and cloak folders were not touched.', 'ok');
      await list.reload();
    } catch (error) {
      setForgetting(false);
      toast(errorText(error), 'error');
    }
  }
  const locked = settings.data?.security.lockedExclusions ?? [];
  return (
    <main class="screen" aria-label="Known repos">
      <header class="adm-head">
        <h1 class="adm-title">Known repos</h1>
        <span class="adm-sub">
          source repos this machine has cloaked from · paths stored sealed
        </span>
        <div class="adm-head-end">
          <Button variant="primary" size="small" onClick={() => setAdding(true)}>
            + Add repo
          </Button>
        </div>
      </header>
      <LoadError message={list.error} />
      {list.data && repos.length === 0 ? (
        <EmptyState title="No repos yet">
          Run repo-cloak inside a repository, or add one here.
        </EmptyState>
      ) : (
        <div class="adm-split">
          <section class="adm-list adm-list-wide" aria-label="Repositories">
            <div class="adm-labels adm-repo-grid">
              <span />
              <span>Repo</span>
              <span class="adm-wide">Worktrees</span>
              <span>Cloaks</span>
              <span class="adm-wide">Last used</span>
            </div>
            {repos.map((repo) => (
              <div
                key={repo.id}
                class={`adm-repo adm-repo-grid${repo.id === activeId ? ' adm-selected' : ''}`}
              >
                <button
                  type="button"
                  class="adm-star"
                  aria-pressed={repo.pinned}
                  aria-label={`${repo.pinned ? 'Unpin' : 'Pin'} ${repo.name}`}
                  onClick={() => void pin(repo)}
                >
                  ★
                </button>
                <button
                  type="button"
                  class="adm-pick"
                  aria-current={repo.id === activeId ? 'true' : undefined}
                  onClick={() => setSelected(repo.id)}
                >
                  <span class="adm-mono-cut">{repo.name}</span>
                  <span class={`adm-mono-cut adm-meta-mono${repo.missing ? ' adm-gone' : ''}`}>
                    {repo.path}
                    {repo.missing && ' — not found'}
                  </span>
                </button>
                <span class="adm-meta-mono adm-wide">{repo.worktreeCount}</span>
                <span class="adm-meta-mono">{repo.workspaceCount}</span>
                <span class="adm-meta adm-wide">{ago(repo.lastUsedAt)}</span>
              </div>
            ))}
          </section>
          <section class="adm-body" aria-label="Repository detail">
            <LoadError message={detail.error} />
            {detail.data && (
              <RepoPanel
                detail={detail.data}
                locked={locked}
                onChanged={detail.set}
                onForget={() => setForgetting(true)}
              />
            )}
          </section>
        </div>
      )}
      <AddRepoDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(repo) => {
          setAdding(false);
          setSelected(repo.id);
          toast(`Added ${repo.name}`, 'ok');
          void list.reload();
        }}
      />
      <Dialog
        title="Forget this repo?"
        open={forgetting}
        onClose={() => setForgetting(false)}
        actions={
          <>
            <Button onClick={() => setForgetting(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => void forget()}>
              Forget repo
            </Button>
          </>
        }
      >
        <p class="adm-note">
          {active?.name} leaves this list and any groups it is in. Its files and cloak folders stay
          where they are, and running repo-cloak inside it brings it back.
        </p>
      </Dialog>
    </main>
  );
}
