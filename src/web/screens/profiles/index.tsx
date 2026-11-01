import { useEffect, useRef, useState } from 'preact/hooks';
import type { ProfileRuleKind, ProfileScopeRef } from '../../api/contracts.js';
import { registerCommands } from '../../shell/commands.js';
import { api } from '../../shell/load.js';
import { navigate } from '../../shell/router.js';
import { overview } from '../../shell/state.js';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Row,
  RowList,
  Tabs,
  toast,
} from '../../shell/ui/index.js';
import { ProfileForm } from './form.js';
import { JsonEditor, OutlinePanel, PasteDialog, ProblemsPanel } from './json.js';
import './profiles.css';
import { isError, saveLabel, useProblems } from './problems.js';
import { addRule, asProfileDoc, exclusionPresets, presetActive, togglePreset } from './rules.js';
import {
  deleteDraft,
  docOf,
  drafts,
  isDirty,
  listError,
  loadDetail,
  loadList,
  newKey,
  profileList,
  reloadDiscarding,
  saveDraft,
  setDoc,
  setScope,
  setText,
  startNew,
} from './state.js';
import type { Draft } from './state.js';
import { Suggestions, Tester } from './tester.js';

const hrefOf = (key: string, json?: boolean) =>
  `#/profiles/${encodeURIComponent(key)}${json ? '/json' : ''}`;
const message = (error: unknown) => (error instanceof Error ? error.message : 'Request failed');

function launchRepo() {
  const launch = overview.value?.launch;
  return launch?.kind === 'repo' || launch?.kind === 'workspace' ? launch.repoId : undefined;
}
/** Hits and suggestions need a repository: the profile's own, the launch one, else the first. */
function targetRepo(draft: Draft | undefined) {
  if (draft?.scope.kind === 'repo') return draft.scope.repoId;
  return launchRepo() ?? overview.value?.repos[0]?.id;
}
const repoName = (id: string | undefined) =>
  overview.value?.repos.find((repo) => repo.id === id)?.name;

function ProfileNav({ selected, repoIds }: { selected: string | undefined; repoIds: string[] }) {
  const draft = selected ? drafts.value[selected] : undefined;
  const doc = draft && docOf(draft);
  const pending = drafts.value[newKey];
  const scopeLabel = (scope: ProfileScopeRef) =>
    scope.kind === 'global' ? 'global' : (repoName(scope.repoId) ?? 'repo');
  return (
    <nav class="pf-nav" aria-label="Profiles">
      {listError.value && (
        <p class="pf-row-error">
          {listError.value}{' '}
          <Button size="small" onClick={() => void loadList(repoIds)}>
            Retry
          </Button>
        </p>
      )}
      <RowList label="Profile list">
        {pending && (
          <Row selected={selected === newKey} onSelect={() => navigate(hrefOf(newKey))}>
            <span class="pf-item">
              <span class="pf-item-top">
                <span class="mono">{docOf(pending)?.name || 'new profile'}</span>
                <span class="pf-note">unsaved</span>
              </span>
            </span>
          </Row>
        )}
        {profileList.value.map((item) => {
          const edited = drafts.value[item.id];
          return (
            <Row
              key={item.id}
              selected={selected === item.id}
              onSelect={() => navigate(hrefOf(item.id))}
            >
              <span class="pf-item">
                <span class="pf-item-top">
                  <span class="mono pf-item-name">{item.name}</span>
                  <span class="pf-note">{scopeLabel(item.scope)}</span>
                </span>
                <span class="pf-note">
                  {item.ruleCount} rule{item.ruleCount === 1 ? '' : 's'} · {item.exclusionCount}{' '}
                  exclusion{item.exclusionCount === 1 ? '' : 's'}
                  {edited && isDirty(edited) ? ' · unsaved' : ''}
                </span>
              </span>
            </Row>
          );
        })}
      </RowList>
      <div class="pf-label pf-presets-label">Exclusion presets</div>
      <div role="group" aria-label="Exclusion presets" class="pf-presets">
        {exclusionPresets.map((preset) => (
          <Checkbox
            key={preset.id}
            label={preset.name}
            disabled={!doc}
            checked={doc ? presetActive(doc, preset) : false}
            onChange={(event) => {
              if (draft && doc)
                setDoc(draft.key, togglePreset(doc, preset, event.currentTarget.checked));
            }}
          />
        ))}
      </div>
    </nav>
  );
}

export function ProfilesScreen({
  profileId,
  json,
}: {
  profileId?: string | undefined;
  json?: boolean | undefined;
}) {
  const repos = overview.value?.repos ?? [];
  const repoIds = repos.map((repo) => repo.id);
  const repoKey = repoIds.join(',');
  const key = profileId ?? profileList.value[0]?.id;
  const draft = key ? drafts.value[key] : undefined;
  const doc = draft && docOf(draft);
  const repo = targetRepo(draft);
  const problems = useProblems(draft?.text);
  const errors = draft ? problems.filter(isError).length : 0;
  const [missing, setMissing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<'paste' | 'delete' | 'export' | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadList(repoKey ? repoKey.split(',') : []);
  }, [repoKey]);
  useEffect(() => {
    setMissing(null);
    if (!key) return;
    if (key === newKey) {
      if (!drafts.value[newKey]) startNew();
      return;
    }
    let live = true;
    loadDetail(key, repo).catch((error: unknown) => {
      if (live) setMissing(message(error));
    });
    return () => {
      live = false;
    };
  }, [key, repo]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (Object.values(drafts.value).some(isDirty)) event.preventDefault();
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, []);
  useEffect(
    () =>
      registerCommands(() => [
        {
          id: 'profiles-new',
          group: 'Actions',
          title: 'New profile',
          icon: '+',
          keywords: ['rules', 'create'],
          run: () => create(),
        },
        ...profileList.value.map((item) => ({
          id: `profile-${item.id}`,
          group: 'Profiles',
          title: item.name,
          subtitle: `${item.ruleCount} rules`,
          icon: '◇',
          keywords: ['profile', 'rules'],
          run: () => navigate(hrefOf(item.id)),
        })),
      ]),
    [],
  );

  function create() {
    if (!drafts.value[newKey]) startNew();
    navigate(hrefOf(newKey));
  }
  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const done = await saveDraft(draft, repoIds, repo);
      toast(done ? 'Profile saved' : 'This profile changed elsewhere', done ? 'ok' : 'error');
    } catch (error) {
      toast(message(error), 'error');
    } finally {
      setSaving(false);
    }
  }
  async function checkConflicts() {
    const selectedRepo = draft?.scope.kind === 'repo' ? draft.scope.repoId : launchRepo();
    const refs = profileList.value
      .filter((item) => item.scope.kind === 'global' || item.scope.repoId === selectedRepo)
      .map(({ id, scope }) => ({ id, scope }));
    if (!refs.length) {
      toast('There are no saved profiles to check.');
      return;
    }
    try {
      const result = await api().call('POST /api/v2/profiles/check', { body: refs });
      toast(`No conflicts across ${result.profiles} profiles, ${result.rules} rules`, 'ok');
    } catch (error) {
      toast(message(error), 'error');
    }
  }
  async function importFile(chosen: File) {
    try {
      if (chosen.size > 1024 * 1024) throw new Error('Profile exceeds 1 MiB');
      const parsed = asProfileDoc(JSON.parse((await chosen.text()).replace(/^\uFEFF/, '')));
      if (!parsed) throw new Error('That file is not a profile document');
      startNew(parsed);
      navigate(hrefOf(newKey));
      toast('Review the imported profile, choose its scope, then save.');
    } catch (error) {
      toast(message(error), 'error');
    }
  }
  function exportDraft() {
    if (!draft) return;
    const url = URL.createObjectURL(new Blob([`${draft.text}\n`], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(doc?.name ?? 'profile').replace(/[^a-z0-9_-]/gi, '_') || 'profile'}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setDialog(null);
  }
  function setMode(next: 'form' | 'json') {
    if (!key) return;
    if (next === 'form' && !doc) {
      toast('Correct the JSON before using the form.', 'error');
      return;
    }
    navigate(hrefOf(key, next === 'json'));
  }
  function addSuggested(kind: ProfileRuleKind, find: string) {
    if (draft && doc) setDoc(draft.key, addRule(doc, kind, find));
  }
  const dirty = draft ? isDirty(draft) : false;

  return (
    // data-placeholder stays until the shell and dashboard tests drop their placeholder rows.
    <main class="screen pf" aria-label="Profiles">
      <header class="pf-head">
        <h1 class="pf-title">Profiles</h1>
        {draft && json && <span class="mono pf-crumb">/ {doc?.name || 'new profile'}</span>}
        <div class="pf-head-actions">
          <input
            ref={file}
            class="pf-file"
            type="file"
            accept="application/json,.json"
            aria-label="Import profile file"
            tabIndex={-1}
            onChange={(event) => {
              const chosen = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (chosen) void importFile(chosen);
            }}
          />
          <Button size="small" onClick={() => file.current?.click()}>
            Import
          </Button>
          <Button size="small" onClick={() => void checkConflicts()}>
            Check conflicts
          </Button>
          <Button size="small" variant="primary" onClick={create}>
            + Profile
          </Button>
        </div>
      </header>
      <div class={json ? 'pf-body pf-body-json' : 'pf-body'}>
        {!json && <ProfileNav selected={key} repoIds={repoIds} />}
        <div class="pf-main">
          {missing ? (
            <EmptyState
              title="Profile unavailable"
              action={<Button onClick={() => navigate('#/profiles')}>Back to profiles</Button>}
            >
              {missing}
            </EmptyState>
          ) : !key ? (
            <EmptyState
              title="No profiles yet"
              action={
                <Button variant="primary" onClick={create}>
                  + Profile
                </Button>
              }
            >
              Profiles hold the names to hide and the files never to pull.
            </EmptyState>
          ) : !draft ? (
            <p class="pf-note pf-loading">Loading…</p>
          ) : (
            <>
              <div class="pf-editor-head">
                {doc ? (
                  <input
                    class="input pf-name pf-mono"
                    aria-label="Profile name"
                    placeholder="profile name"
                    value={doc.name}
                    onInput={(event) =>
                      setDoc(draft.key, { ...doc, name: event.currentTarget.value })
                    }
                  />
                ) : (
                  <span class="mono pf-name-static">JSON being edited</span>
                )}
                {draft.id ? (
                  <span class="pf-note">
                    {draft.scope.kind === 'global'
                      ? 'global'
                      : `repo · ${repoName(draft.scope.repoId) ?? draft.scope.repoId}`}{' '}
                    · used by {draft.usedBy} workspace{draft.usedBy === 1 ? '' : 's'}
                  </span>
                ) : (
                  <Field
                    label="Scope"
                    control={(props) => (
                      <select
                        {...props}
                        class="input pf-cell"
                        value={draft.scope.kind === 'global' ? 'global' : draft.scope.repoId}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setScope(
                            draft.key,
                            value === 'global'
                              ? { kind: 'global' }
                              : { kind: 'repo', repoId: value },
                          );
                        }}
                      >
                        <option value="global">All repositories</option>
                        {repos.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    )}
                  />
                )}
                <div class="pf-editor-actions">
                  <Tabs
                    segmented
                    label="Editor mode"
                    tabs={[
                      { id: 'form', label: 'Form' },
                      { id: 'json', label: 'JSON' },
                    ]}
                    value={json ? 'json' : 'form'}
                    onChange={setMode}
                  />
                  {json && (
                    <Button size="small" disabled={!doc} onClick={() => setDialog('paste')}>
                      Paste from LLM
                    </Button>
                  )}
                  <Button size="small" onClick={() => setDialog('export')}>
                    Export
                  </Button>
                  <Button size="small" variant="danger" onClick={() => setDialog('delete')}>
                    {draft.id ? 'Delete' : 'Discard'}
                  </Button>
                  <Button
                    size="small"
                    variant="primary"
                    disabled={saving || errors > 0 || !dirty}
                    onClick={() => void save()}
                  >
                    {saveLabel(errors, saving)}
                  </Button>
                </div>
              </div>
              {draft.stale && (
                <div class="pf-stale" role="alert">
                  <span>
                    This profile changed in another tab or terminal. Saving would overwrite it.
                  </span>
                  <Button
                    size="small"
                    onClick={() => {
                      if (draft.id)
                        reloadDiscarding(draft.id, repo).catch((error: unknown) =>
                          toast(message(error), 'error'),
                        );
                    }}
                  >
                    Reload and discard my edits
                  </Button>
                </div>
              )}
              {json ? (
                <JsonEditor
                  text={draft.text}
                  savedText={draft.savedText}
                  problems={problems}
                  onText={(text) => setText(draft.key, text)}
                />
              ) : doc ? (
                <div class="pf-form">
                  <Field
                    label="Description"
                    value={doc.description ?? ''}
                    onInput={(event) => {
                      const { description: _old, ...rest } = doc;
                      void _old;
                      const value = event.currentTarget.value;
                      setDoc(
                        draft.key,
                        value ? { ...rest, description: value } : (rest as typeof doc),
                      );
                    }}
                  />
                  <ProfileForm
                    doc={doc}
                    hits={draft.hits}
                    hitsIn={repoName(repo)}
                    locked={draft.locked}
                    problems={problems}
                    onChange={(next) => setDoc(draft.key, next)}
                  />
                </div>
              ) : (
                <EmptyState
                  title="The form cannot draw this JSON"
                  action={<Button onClick={() => setMode('json')}>Back to JSON</Button>}
                >
                  Correct it in JSON mode first.
                </EmptyState>
              )}
            </>
          )}
        </div>
        {draft && (
          <aside class="pf-aside" aria-label={json ? 'Problems and outline' : 'Tester'}>
            {json ? (
              <>
                <ProblemsPanel problems={problems} />
                <OutlinePanel doc={doc} inherited={draft.locked.length} />
                <section class="pf-side" aria-label="Paste from LLM help">
                  <h2 class="pf-side-title">Paste from LLM</h2>
                  <p class="pf-note">
                    Paste a profile an AI wrote. It is validated, diffed against this one and never
                    saved until you accept each change. Secret values in pasted JSON are refused.
                  </p>
                </section>
              </>
            ) : (
              <>
                <Tester text={draft.text} />
                <Suggestions repo={repo} repoName={repoName(repo)} doc={doc} onAdd={addSuggested} />
                <p class="pf-side pf-note">
                  Profile file is sealed at rest. Export writes plain JSON on purpose, with a
                  warning.
                </p>
              </>
            )}
          </aside>
        )}
      </div>
      <PasteDialog
        open={dialog === 'paste'}
        current={doc}
        onClose={() => setDialog(null)}
        onApply={(next) => {
          if (draft) setDoc(draft.key, next);
          toast('Accepted changes applied. Review, then save.');
        }}
      />
      <Dialog
        title="Export as plain JSON?"
        open={dialog === 'export'}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" onClick={exportDraft}>
              Export plain JSON
            </Button>
          </>
        }
      >
        This file is not sealed. It lists the real names this profile hides, so keep it out of
        repositories and shared folders.
      </Dialog>
      <Dialog
        title={draft?.id ? 'Delete this profile?' : 'Discard this new profile?'}
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setDialog(null);
                if (draft)
                  deleteDraft(draft, repoIds).catch((error: unknown) =>
                    toast(message(error), 'error'),
                  );
              }}
            >
              {draft?.id ? 'Delete profile' : 'Discard'}
            </Button>
          </>
        }
      >
        {draft?.id
          ? 'Workspaces already pulled keep their rules, but new pulls cannot select it.'
          : 'Nothing has been saved.'}
      </Dialog>
    </main>
  );
}
