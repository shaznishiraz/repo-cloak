import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  CommitEntry,
  NewCloakContext,
  NewCloakReview,
  ProfileListItem,
  TreeNode,
  UncommittedFile,
  WorktreeOption,
} from '../../api/contracts.js';
import { registerCommands } from '../../shell/commands.js';
import { api } from '../../shell/load.js';
import { navigate } from '../../shell/router.js';
import { overview } from '../../shell/state.js';
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Kbd,
  buttonClass,
  toast,
} from '../../shell/ui/index.js';
import { runCreate } from './create.js';
import type { GroupChoice } from './create.js';
import { FolderPicker } from './folder-picker.js';
import { joinFolder, lastSegment, launchTarget, nameProblem, relativeTime } from './model.js';
import type { Target } from './model.js';
import { ReviewAside } from './review.js';
import { FileTree } from './tree.js';
import './new.css';

const neverPull = 'Never pull';
const variables = ['{dest}', '{source}', '{branch}', '{name}', '{group}', '{sha}'];
const statusLabel: Record<UncommittedFile['status'], string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  '?': 'untracked',
};
const profileKey = (profile: ProfileListItem) => `${profile.scope.kind}:${profile.id}`;
const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

function pluralFiles(count: number) {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

export function NewCloakScreen() {
  const data = overview.value;
  const detected = launchTarget(data);
  const [picked, setPicked] = useState<Target | null>(null);
  const target = picked ?? detected;
  const repoId = target?.repoId;
  const worktree = target?.worktree;

  const [context, setContext] = useState<NewCloakContext | null>(null);
  const [trees, setTrees] = useState<WorktreeOption[]>([]);
  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [uncommitted, setUncommitted] = useState<UncommittedFile[]>([]);
  const [uncommittedOn, setUncommittedOn] = useState(true);
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [commitsOn, setCommitsOn] = useState(true);
  const [pickedCommits, setPickedCommits] = useState<ReadonlyMap<string, CommitEntry>>(new Map());
  const [search, setSearch] = useState('');
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [pathsOn, setPathsOn] = useState(true);
  const [paths, setPaths] = useState<ReadonlySet<string>>(new Set());
  const nodes = useRef(new Map<string, TreeNode>());
  const [treeTotal, setTreeTotal] = useState<number | null>(null);

  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<'new' | 'add'>('new');
  const [addTo, setAddTo] = useState<string | null>(null);
  const [typedName, setTypedName] = useState<string | null>(null);
  const suffix = useMemo(
    () =>
      [...crypto.getRandomValues(new Uint8Array(2))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    [],
  );
  const [destinationRoot, setDestinationRoot] = useState('');
  const [picking, setPicking] = useState(false);
  const [groupValue, setGroupValue] = useState('');
  const [newGroup, setNewGroup] = useState('');
  const [commandsOpen, setCommandsOpen] = useState(true);
  const [commands, setCommands] = useState<string[]>([]);

  const [review, setReview] = useState<NewCloakReview | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [ignored, setIgnored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadTree = useCallback(
    async (directory?: string) => {
      if (!repoId || !worktree) return [];
      const result = await api().call('GET /api/v2/new/tree', {
        query: { repo: repoId, worktree, ...(directory ? { directory } : {}) },
      });
      return result.nodes;
    },
    [repoId, worktree],
  );

  async function loadChanges(text: string, offset: number) {
    if (!repoId || !worktree) return;
    const result = await api().call('GET /api/v2/new/changes', {
      query: {
        repo: repoId,
        worktree,
        ...(offset ? { offset: String(offset) } : {}),
        ...(text ? { search: text } : {}),
      },
    });
    setUncommitted(result.uncommitted);
    setCommits((current) => (offset ? [...current, ...result.commits] : result.commits));
    setNextOffset(result.nextOffset);
  }

  useEffect(() => {
    setContext(null);
    setReview(null);
    setUncommitted([]);
    setCommits([]);
    setPickedCommits(new Map());
    setPaths(new Set());
    setDeselected(new Set());
    setMode('new');
    setTreeTotal(null);
    nodes.current = new Map();
    if (!repoId || !worktree) return;
    let live = true;
    void (async () => {
      try {
        setLoadError(null);
        const client = api();
        const [nextContext, list, nextTrees] = await Promise.all([
          client.call('GET /api/v2/new/context', { query: { repo: repoId, worktree } }),
          client.call('GET /api/v2/profiles', { query: { repo: repoId } }),
          client.call('GET /api/v2/worktrees/:repoId', { params: { repoId } }),
        ]);
        if (!live) return;
        setContext(nextContext);
        setProfiles(list.profiles);
        setTrees(nextTrees.worktrees);
        const usable = list.profiles.filter((profile) => profile.name !== neverPull);
        setChosen(new Set(usable.length === 1 ? usable.map(profileKey) : []));
        setAddTo(nextContext.existing[0]?.workspaceId ?? null);
        await loadChanges('', 0);
      } catch (cause) {
        if (live) setLoadError(message(cause, 'Could not read this worktree'));
      }
    })();
    return () => {
      live = false;
    };
  }, [repoId, worktree]);

  // Default commands live in Settings, which 50-admin serves; the sheet works without them.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const settings = await api().call('GET /api/v2/settings');
        if (live) setCommands(settings.postCreateCommands);
      } catch {
        /* Keep an empty list: the user can still type commands. */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!repoId || !worktree || !context) return;
    const timer = setTimeout(() => {
      void loadChanges(search.trim(), 0).catch((cause: unknown) =>
        setLoadError(message(cause, 'Could not search commits')),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const selectableUncommitted = uncommitted.filter((file) => !file.excluded && file.status !== 'D');
  const selectedUncommitted = selectableUncommitted
    .filter((file) => !deselected.has(file.path))
    .map((file) => file.path);
  const usableProfiles = profiles.filter((profile) => profile.name !== neverPull);
  const alwaysOn = profiles.find((profile) => profile.name === neverPull);
  const selectedProfiles = usableProfiles.filter((profile) => chosen.has(profileKey(profile)));
  const adding = mode === 'add';

  const selection = useMemo(
    () => ({
      uncommitted: uncommittedOn ? selectedUncommitted : [],
      commits: commitsOn ? [...pickedCommits.keys()] : [],
      paths: pathsOn ? [...paths] : [],
      profiles: adding
        ? []
        : selectedProfiles.map((profile) => ({ id: profile.id, scope: profile.scope })),
    }),
    [
      uncommittedOn,
      selectedUncommitted.join('\0'),
      commitsOn,
      pickedCommits,
      pathsOn,
      paths,
      adding,
      selectedProfiles.map(profileKey).join('\0'),
    ],
  );
  const hasSelection =
    selection.uncommitted.length + selection.commits.length + selection.paths.length > 0;

  const reviewRun = useRef(0);
  useEffect(() => {
    if (!repoId || !worktree || !context) return;
    const run = ++reviewRun.current;
    if (!hasSelection && !selection.profiles.length) {
      setReview(null);
      setReviewError(null);
      setReviewing(false);
      return;
    }
    setReviewing(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const next = await api().call('POST /api/v2/new/review', {
            body: { repoId, worktree, ...selection },
          });
          if (run !== reviewRun.current) return;
          setReview(next);
          setReviewError(null);
        } catch (cause) {
          if (run !== reviewRun.current) return;
          setReviewError(message(cause, 'Could not review this selection'));
        } finally {
          if (run === reviewRun.current) setReviewing(false);
        }
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [selection, context, repoId, worktree]);

  // An ignore covers the names the user actually saw, not ones a later selection brings in.
  const leftoverKey = review?.leftovers.map((item) => `${item.path}\0${item.name}`).join('\n');
  useEffect(() => setIgnored(false), [leftoverKey]);

  const heldBack = useMemo(
    () => new Map((review?.heldBack ?? []).map((item) => [item.path, item.rule])),
    [review],
  );

  const existing = context?.existing.find((item) => item.workspaceId === addTo);
  const suggested = review?.pathPreview[0]?.cloaked;
  const name = typedName ?? (suggested ? `${suggested}-${suffix}` : '');
  const root = context?.destinationLocked ? (context.destinationRoot ?? '') : destinationRoot;
  const destination = root && !nameProblem(name) ? joinFolder(root, name.trim()) : '';
  const groupChoice: GroupChoice =
    groupValue === ''
      ? { kind: 'none' }
      : groupValue === 'new'
        ? { kind: 'new', name: newGroup.trim() }
        : { kind: 'existing', id: groupValue };
  const groupName =
    groupChoice.kind === 'new'
      ? groupChoice.name
      : groupChoice.kind === 'existing'
        ? context?.groups.find((group) => group.id === groupChoice.id)?.name
        : undefined;

  const nameIssue = nameProblem(name);
  const blocker = !context
    ? 'Choose a repository first.'
    : !hasSelection
      ? 'Pick something to pull.'
      : reviewError
        ? 'Fix the problem above first.'
        : reviewing || !review
          ? 'Reviewing…'
          : !review.files
            ? 'No selected files remain after exclusions.'
            : adding
              ? existing
                ? null
                : 'Choose a cloak to add to.'
              : !selectedProfiles.length
                ? 'Choose at least one profile.'
                : review.leftovers.length && !ignored
                  ? 'Add a rule for the leftovers or ignore them.'
                  : nameIssue
                    ? nameIssue
                    : !destination
                      ? 'Choose where the cloak goes.'
                      : groupChoice.kind === 'new' && !groupChoice.name
                        ? 'Name the new group.'
                        : null;

  async function create() {
    if (blocker || busy || !repoId || !worktree) return;
    setBusy(true);
    setCreateError(null);
    try {
      const outcome = await runCreate(
        adding && existing
          ? {
              repoId,
              worktree,
              ...selection,
              name: existing.name,
              destination: existing.path,
              postCreateCommands: [],
              ignoreLeftovers: true,
            }
          : {
              repoId,
              worktree,
              ...selection,
              name: name.trim(),
              destination,
              ...(groupChoice.kind === 'existing' ? { groupId: groupChoice.id } : {}),
              postCreateCommands: commands.map((line) => line.trim()).filter(Boolean),
              ignoreLeftovers: ignored,
            },
        adding ? { kind: 'none' } : groupChoice,
      );
      toast(
        adding
          ? `Added ${pluralFiles(outcome.files)} to ${existing?.name ?? 'the cloak'}`
          : `Cloak created · ${pluralFiles(outcome.files)}`,
      );
      for (const warning of outcome.warnings) toast(warning, 'error');
      navigate(`#/ws/${encodeURIComponent(outcome.workspaceId)}`);
    } catch (cause) {
      setCreateError(message(cause, 'Could not create the cloak'));
    } finally {
      setBusy(false);
    }
  }

  // Keyboard and palette read the latest closure, not the one from when they were registered.
  const latest = useRef({ create, blocker });
  latest.current = { create, blocker };
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void latest.current.create();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        navigate('#/');
      }
    }
    document.addEventListener('keydown', onKey);
    const unregister = registerCommands(() => [
      {
        id: 'new-create',
        group: 'Actions',
        title: 'Create this cloak',
        icon: '+',
        run: () => void latest.current.create(),
      },
    ]);
    return () => {
      document.removeEventListener('keydown', onKey);
      unregister();
    };
  }, []);

  const repository = data?.repos.find((repo) => repo.id === repoId);
  const mainBranch = trees[0]?.branch;
  const inner =
    repository && worktree && worktree !== repository.path && worktree.startsWith(repository.path)
      ? worktree.slice(repository.path.length + 1)
      : null;
  const commitFiles = [...pickedCommits.values()].reduce((sum, commit) => sum + commit.files, 0);
  const pathFiles = [...paths].reduce(
    (sum, path) => sum + (nodes.current.get(path)?.files ?? 0),
    0,
  );
  const ruleTotal = selectedProfiles.reduce((sum, profile) => sum + profile.ruleCount, 0);
  const exclusionTotal =
    selectedProfiles.reduce((sum, profile) => sum + profile.exclusionCount, 0) +
    (alwaysOn?.exclusionCount ?? 0);
  const onNodes = useCallback((list: TreeNode[]) => {
    for (const node of list) nodes.current.set(node.path, node);
    if (list.some((node) => !node.path.includes('/')))
      setTreeTotal(list.reduce((sum, node) => sum + node.files, 0));
  }, []);

  const createLabel = adding
    ? `Add to ${existing?.name ?? 'cloak'} · ${pluralFiles(review?.files ?? 0)}`
    : `Create cloak · ${pluralFiles(review?.files ?? 0)}`;

  // aria-label and data-placeholder stay for the shell's route tests until 90-cutover rewrites them.
  return (
    <main class="screen new-cloak" aria-label="New cloak" data-placeholder="20-new-cloak">
      <div class="new-head">
        <h1 class="new-title">New cloak</h1>
        <span class="new-hint">
          esc to cancel · <Kbd>⌘↵</Kbd> to create
        </span>
      </div>

      {!data ? (
        <p class="new-loading muted">Loading…</p>
      ) : !data.repos.length ? (
        <EmptyState
          title="No repositories yet"
          action={
            <a class={buttonClass('secondary')} href="#/repos">
              Add a repository
            </a>
          }
        >
          Run repo-cloak inside a repository, or add one here.
        </EmptyState>
      ) : (
        <>
          {!data.workspacesRoot && data.profileCount === 0 && (
            <div class="new-banner new-banner-setup">
              First time here? <a href="#/setup">Finish first-run setup</a> to pick a cloak folder
              and your first profile.
            </div>
          )}

          <section class="new-banner" aria-label="Detected source">
            <span class="new-banner-label">{picked ? 'Selected' : 'Detected'}</span>
            {context && (
              <span class="mono new-banner-place">
                {inner ? (
                  <>
                    worktree <span class="strong">{inner}</span> <span class="dim">of</span>{' '}
                  </>
                ) : null}
                {repository?.name} <span class="dim">·</span>{' '}
                <span class="pull">{context.branch ?? 'detached HEAD'}</span>
                {context.ahead > 0 && (
                  <span class="dim">
                    {' '}
                    · {context.ahead} ahead{mainBranch ? ` of ${mainBranch}` : ''}
                  </span>
                )}
              </span>
            )}
            <div class="new-banner-pick">
              <label class="inline-select">
                <span class="sr-only">Repository</span>
                <select
                  class="input"
                  value={repoId ?? ''}
                  onChange={(event) => {
                    const repo = data.repos.find((item) => item.id === event.currentTarget.value);
                    if (repo) setPicked({ repoId: repo.id, worktree: repo.path });
                  }}
                >
                  {!repoId && <option value="">Choose a repository…</option>}
                  {data.repos
                    .filter((repo) => !repo.missing)
                    .map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.name}
                      </option>
                    ))}
                </select>
              </label>
              {trees.length > 1 && repoId && (
                <label class="inline-select">
                  <span class="sr-only">Worktree</span>
                  <select
                    class="input"
                    value={worktree ?? ''}
                    onChange={(event) => setPicked({ repoId, worktree: event.currentTarget.value })}
                  >
                    {trees.map((tree) => (
                      <option key={tree.path} value={tree.path}>
                        {tree.branch ?? lastSegment(tree.path)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {context && context.existing.length > 0 && (
              <div class="new-banner-existing">
                Already cloaked as
                {context.existing.length > 1 ? (
                  <label class="inline-select">
                    <span class="sr-only">Existing cloak</span>
                    <select
                      class="input"
                      value={addTo ?? ''}
                      onChange={(event) => setAddTo(event.currentTarget.value)}
                    >
                      {context.existing.map((item) => (
                        <option key={item.workspaceId} value={item.workspaceId}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span class="mono strong">{existing?.name}</span>
                )}
                <a
                  class={buttonClass('secondary', 'small')}
                  href={`#/ws/${encodeURIComponent(addTo ?? '')}`}
                >
                  Open it
                </a>
                <div class="segment" role="group" aria-label="What to do with this selection">
                  <button
                    type="button"
                    aria-pressed={adding}
                    class={adding ? 'segment-on' : ''}
                    onClick={() => setMode('add')}
                  >
                    Add to it{adding ? ' ✓' : ''}
                  </button>
                  <button
                    type="button"
                    aria-pressed={!adding}
                    class={adding ? '' : 'segment-on'}
                    onClick={() => setMode('new')}
                  >
                    New cloak{adding ? '' : ' ✓'}
                  </button>
                </div>
              </div>
            )}
          </section>

          {loadError && (
            <div class="new-error" role="alert">
              {loadError}
            </div>
          )}
          {createError && (
            <div class="new-error" role="alert">
              {createError}
            </div>
          )}

          {!target ? (
            <EmptyState title="Choose a repository">
              Pick the repository to cloak from the list above.
            </EmptyState>
          ) : (
            <div class="new-layout">
              <div class="new-builder">
                <section class="sheet" aria-label="What to pull">
                  <header class="sheet-head">
                    <span class="sheet-step">1</span>
                    <h2 class="sheet-title">What to pull</h2>
                    <span class="muted">mix any of the three, they merge and dedupe</span>
                    <span class="sheet-count">{pluralFiles(review?.files ?? 0)}</span>
                  </header>

                  <div class="source">
                    <div class="source-head">
                      <Checkbox
                        checked={uncommittedOn}
                        onChange={(event) => setUncommittedOn(event.currentTarget.checked)}
                        label={
                          <>
                            Uncommitted changes{' '}
                            <span class="source-count">
                              {selectedUncommitted.length} of {selectableUncommitted.length}
                            </span>
                          </>
                        }
                      />
                      <span class="source-note">from git status, no disk scan</span>
                    </div>
                    <div class="chips">
                      {uncommitted.length === 0 && (
                        <span class="muted">No uncommitted changes.</span>
                      )}
                      {uncommitted.slice(0, 200).map((file) => {
                        const locked = file.excluded || file.status === 'D';
                        const on = !locked && !deselected.has(file.path);
                        return (
                          <button
                            type="button"
                            key={file.path}
                            class={`file-chip${on ? ' file-chip-on' : ''}`}
                            aria-pressed={on}
                            disabled={locked}
                            title={`${statusLabel[file.status]}${file.excluded ? ', excluded' : ''}`}
                            onClick={() => {
                              const next = new Set(deselected);
                              if (!next.delete(file.path)) next.add(file.path);
                              setDeselected(next);
                            }}
                          >
                            <span
                              class={`status status-${file.excluded ? 'x' : file.status === '?' ? 'A' : file.status}`}
                            >
                              {file.excluded ? '×' : file.status}
                            </span>{' '}
                            {file.path}
                          </button>
                        );
                      })}
                      {uncommitted.length > 200 && (
                        <span class="muted">and {uncommitted.length - 200} more, all included</span>
                      )}
                    </div>
                  </div>

                  <div class="source">
                    <div class="source-head">
                      <Checkbox
                        checked={commitsOn}
                        onChange={(event) => setCommitsOn(event.currentTarget.checked)}
                        label={
                          <>
                            Commits{' '}
                            <span class="source-count">
                              {pickedCommits.size} picked · {pluralFiles(commitFiles)}
                            </span>
                          </>
                        }
                      />
                      <label class="commit-search">
                        <span class="sr-only">Search commits</span>
                        <input
                          type="text"
                          value={search}
                          placeholder="Search older commits: sha, message, author…"
                          onInput={(event) => setSearch(event.currentTarget.value)}
                        />
                      </label>
                    </div>
                    <div class="commits">
                      {commits.length === 0 && (
                        <span class="muted">
                          {search ? 'No matching commits.' : 'No commits yet.'}
                        </span>
                      )}
                      {commits.map((commit) => (
                        <label class="commit" key={commit.sha}>
                          <input
                            type="checkbox"
                            checked={pickedCommits.has(commit.sha)}
                            onChange={(event) => {
                              const next = new Map(pickedCommits);
                              if (event.currentTarget.checked) next.set(commit.sha, commit);
                              else next.delete(commit.sha);
                              setPickedCommits(next);
                            }}
                          />
                          <span class="commit-sha">{commit.sha.slice(0, 7)}</span>
                          <span class="commit-subject" title={commit.subject}>
                            {commit.subject}
                          </span>
                          <span class="commit-when">{relativeTime(commit.when)}</span>
                          <span class="commit-files">{commit.files} f</span>
                        </label>
                      ))}
                      {nextOffset !== null && (
                        <button
                          type="button"
                          class="link-button"
                          onClick={() =>
                            void loadChanges(search.trim(), nextOffset).catch((cause: unknown) =>
                              setLoadError(message(cause, 'Could not load commits')),
                            )
                          }
                        >
                          More commits
                        </button>
                      )}
                    </div>
                  </div>

                  <div class="source">
                    <div class="source-head">
                      <Checkbox
                        checked={pathsOn}
                        onChange={(event) => setPathsOn(event.currentTarget.checked)}
                        label={
                          <>
                            Files &amp; folders{' '}
                            <span class="source-count">
                              {paths.size} picked · {pluralFiles(pathFiles)}
                            </span>
                          </>
                        }
                      />
                      <span class="source-note">
                        git ls-files
                        {treeTotal !== null ? ` · ${treeTotal.toLocaleString()} files` : ''}
                      </span>
                    </div>
                    {target && (
                      <FileTree
                        load={loadTree}
                        paths={paths}
                        heldBack={heldBack}
                        onChange={setPaths}
                        onNodes={onNodes}
                      />
                    )}
                  </div>
                </section>

                {!adding && (
                  <section class="sheet sheet-row">
                    <div class="sheet-cell">
                      <div class="sheet-cell-head">
                        <span class="sheet-step">2</span>
                        <h2 class="sheet-title">Profiles</h2>
                      </div>
                      <div class="chips chips-profiles">
                        {usableProfiles.map((profile) => {
                          const on = chosen.has(profileKey(profile));
                          return (
                            <button
                              type="button"
                              key={profileKey(profile)}
                              class={`profile-chip${on ? ' profile-chip-on' : ''}`}
                              aria-pressed={on}
                              onClick={() => {
                                const next = new Set(chosen);
                                if (!next.delete(profileKey(profile)))
                                  next.add(profileKey(profile));
                                setChosen(next);
                              }}
                            >
                              {profile.name}
                              {on ? ' ✓' : ''}
                            </button>
                          );
                        })}
                        {alwaysOn && (
                          <span
                            class="profile-chip profile-chip-locked"
                            title="Added to every cloak"
                          >
                            {neverPull} · always on
                          </span>
                        )}
                        <a class="profile-chip profile-chip-add" href="#/profiles">
                          + add
                        </a>
                      </div>
                      <div class="cell-note">
                        {ruleTotal} rules · {exclusionTotal} exclusions
                        {reviewError ? '' : ' · no conflicts'}
                      </div>
                    </div>

                    <div class="sheet-cell">
                      <div class="sheet-cell-head">
                        <span class="sheet-step">3</span>
                        <h2 class="sheet-title">Name &amp; place</h2>
                      </div>
                      <Field
                        label="Name"
                        value={name}
                        class="input input-mono"
                        error={name ? nameProblem(name) : undefined}
                        onInput={(event) => setTypedName(event.currentTarget.value)}
                      />
                      {context?.destinationLocked ? (
                        <div class="cell-note mono-note">
                          → {destination || context.destinationRoot}{' '}
                          <span class="ui-font">· fixed in Settings</span>
                        </div>
                      ) : (
                        <>
                          <div class="place-row">
                            <Field
                              label="Folder for cloaks"
                              value={destinationRoot}
                              class="input input-mono"
                              onInput={(event) => setDestinationRoot(event.currentTarget.value)}
                            />
                            <Button size="small" onClick={() => setPicking(true)}>
                              Browse
                            </Button>
                          </div>
                          {destination && <div class="cell-note mono-note">→ {destination}</div>}
                        </>
                      )}
                    </div>

                    <div class="sheet-cell">
                      <div class="sheet-cell-head">
                        <span class="sheet-step">4</span>
                        <h2 class="sheet-title">Group</h2>
                      </div>
                      <Field
                        label="Join group"
                        control={(props) => (
                          <select
                            {...props}
                            class="input"
                            value={groupValue}
                            onChange={(event) => setGroupValue(event.currentTarget.value)}
                          >
                            <option value="">No group</option>
                            {context?.groups.map((group) => (
                              <option key={group.id} value={group.id}>
                                {group.name} ({group.workspaceCount})
                              </option>
                            ))}
                            <option value="new">New group…</option>
                          </select>
                        )}
                      />
                      {groupValue === 'new' && (
                        <Field
                          label="New group name"
                          value={newGroup}
                          onInput={(event) => setNewGroup(event.currentTarget.value)}
                        />
                      )}
                      <div class="cell-note">
                        {groupValue
                          ? 'Joins after the cloak is created. Bulk pull and push together.'
                          : 'Stays on its own. You can add it to a group later.'}
                      </div>
                    </div>
                  </section>
                )}

                {!adding && (
                  <section class="sheet">
                    <header class="sheet-head">
                      <button
                        type="button"
                        class="sheet-toggle"
                        aria-expanded={commandsOpen}
                        aria-label="After create commands"
                        onClick={() => setCommandsOpen(!commandsOpen)}
                      >
                        <span aria-hidden="true">{commandsOpen ? '▾' : '▸'}</span>
                      </button>
                      <h2 class="sheet-title">After create</h2>
                      <span class="muted">commands run in the cloak folder, never in source</span>
                    </header>
                    {commandsOpen && (
                      <div class="commands">
                        {commands.map((command, index) => (
                          <div class="command" key={index}>
                            <span class="dim mono">$</span>
                            <input
                              class="input input-mono"
                              aria-label={`Command ${index + 1}`}
                              value={command}
                              onInput={(event) => {
                                const next = [...commands];
                                next[index] = event.currentTarget.value;
                                setCommands(next);
                              }}
                            />
                            <button
                              type="button"
                              class="link-button"
                              aria-label={`Remove command ${index + 1}`}
                              onClick={() => setCommands(commands.filter((_, at) => at !== index))}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <div class="command-tools">
                          {commands.length < 10 && (
                            <Button size="small" onClick={() => setCommands([...commands, ''])}>
                              Add command
                            </Button>
                          )}
                          <span class="muted">variables</span>
                          {variables.map((variable) => (
                            <span class="variable" key={variable}>
                              {variable}
                            </span>
                          ))}
                          <span class="muted">quoted for you, so leave quotes off</span>
                        </div>
                      </div>
                    )}
                  </section>
                )}
              </div>

              <ReviewAside
                review={review}
                error={reviewError}
                loading={reviewing}
                adding={adding}
                group={adding ? null : (groupName ?? null)}
                ignored={ignored}
                onIgnore={setIgnored}
                createLabel={createLabel}
                blocker={blocker}
                busy={busy}
                onCreate={() => void create()}
              />
            </div>
          )}
        </>
      )}
      {picking && (
        <FolderPicker
          initial={destinationRoot || undefined}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            setDestinationRoot(path);
            setPicking(false);
          }}
        />
      )}
    </main>
  );
}
