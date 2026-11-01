import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { SetupState } from '../../api/contracts.js';
import { FolderPicker } from '../../shell/folder-picker.js';
import { api } from '../../shell/load.js';
import { navigate } from '../../shell/router.js';
import { overview, sessionInfo } from '../../shell/state.js';
import { Button, Checkbox, Field, buttonClass, toast } from '../../shell/ui/index.js';
import { refreshOverview } from '../new/create.js';
import './setup.css';

const message = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;
function keyLabel(keyId: string | null | undefined, storage: SetupState['key']['storage']) {
  const place = storage === 'keychain' ? 'OS keychain' : 'key file';
  if (!keyId) return place;
  const id = keyId.replace(/^k_/, '');
  return `key ${id.slice(0, 4)}…${id.slice(-3)} · ${place}`;
}

function Step({
  mark,
  state,
  title,
  description,
  value,
  action,
  children,
}: {
  mark: string;
  state: 'done' | 'current' | 'todo';
  title: string;
  description: string;
  value: ComponentChildren;
  action: ComponentChildren;
  children?: ComponentChildren;
}) {
  return (
    <section class={`step step-${state}`} aria-label={title}>
      <span class="step-mark" aria-hidden="true">
        {state === 'done' ? '✓' : mark}
      </span>
      <div class="step-text">
        <h2 class="step-title">
          {title}
          {state === 'done' && <span class="sr-only"> (done)</span>}
        </h2>
        <p class="step-description">{description}</p>
        <p class="step-value">{value}</p>
      </div>
      <div class="step-action">{action}</div>
      {children && <div class="step-body">{children}</div>}
    </section>
  );
}

export function SetupScreen() {
  const launch = overview.value?.launch;
  const repo = launch?.kind === 'repo' || launch?.kind === 'workspace' ? launch.repoId : undefined;
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [rootOpen, setRootOpen] = useState(false);
  const [rootDraft, setRootDraft] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);

  const [presetsOpen, setPresetsOpen] = useState(false);
  const [enabled, setEnabled] = useState<ReadonlySet<string>>(new Set());
  const [presetsSaved, setPresetsSaved] = useState(false);

  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await api().call('GET /api/v2/setup', { query: repo ? { repo } : {} });
        if (!live) return;
        setState(next);
        setEnabled(
          new Set(next.exclusionPresets.filter((item) => item.enabled).map((item) => item.id)),
        );
        setRootDraft(next.workspacesRoot ?? '');
      } catch (cause) {
        if (live) setError(message(cause, 'Could not read first-run state'));
      }
    })();
    return () => {
      live = false;
    };
  }, [repo]);

  /** PUT answers without repository context, so the repo-derived fields are kept. */
  async function save(body: { workspacesRoot?: string; presets?: string[] }) {
    const next = await api().call('PUT /api/v2/setup', { body });
    setState((current) =>
      current
        ? { ...next, suggestedNames: current.suggestedNames, profileCount: current.profileCount }
        : next,
    );
    const info = await api().call('GET /api/v2/session');
    sessionInfo.value = info;
    await refreshOverview().catch(() => undefined);
    return next;
  }

  async function saveRoot() {
    setRootError(null);
    setSaving(true);
    try {
      await save({ workspacesRoot: rootDraft.trim() });
      setRootOpen(false);
    } catch (cause) {
      setRootError(message(cause, 'Could not use that folder'));
    } finally {
      setSaving(false);
    }
  }

  async function savePresets() {
    setError(null);
    setSaving(true);
    try {
      await save({ presets: [...enabled] });
      setPresetsSaved(true);
      setPresetsOpen(false);
    } catch (cause) {
      setError(message(cause, 'Could not save the exclusions'));
    } finally {
      setSaving(false);
    }
  }

  async function saveProfile() {
    if (!state) return;
    setProfileError(null);
    setSaving(true);
    try {
      await api().call('POST /api/v2/profiles', {
        body: {
          scope: { kind: 'global' },
          document: {
            kind: 'profile',
            schemaVersion: 1,
            name: profileName.trim(),
            rules: Object.entries(replacements)
              .filter(([, replace]) => replace.trim())
              .map(([match, replace], index) => ({
                id: `name-${index + 1}`,
                type: 'literal',
                match,
                replace: replace.trim(),
              })),
          },
        },
      });
      setState({ ...state, profileCount: state.profileCount + 1 });
      setProfileOpen(false);
      await refreshOverview().catch(() => undefined);
    } catch (cause) {
      setProfileError(message(cause, 'Could not save the profile'));
    } finally {
      setSaving(false);
    }
  }

  async function finish() {
    setError(null);
    setSaving(true);
    try {
      // Presets only take effect once saved, including the defaults nobody opened.
      await save({ presets: [...enabled] });
      toast('First-run setup saved');
      navigate('#/new');
    } catch (cause) {
      setError(message(cause, 'Could not finish setup'));
    } finally {
      setSaving(false);
    }
  }

  const presets = state?.exclusionPresets ?? [];
  const on = presets.filter((item) => enabled.has(item.id));
  const patterns = on.reduce((sum, item) => sum + item.patterns.length, 0);
  const done = [
    !!state?.key.exists,
    !!state?.workspacesRoot,
    presetsSaved,
    (state?.profileCount ?? 0) > 0,
  ];
  const firstOpen = done.indexOf(false);
  const stepState = (index: number) =>
    done[index]
      ? ('done' as const)
      : index === firstOpen
        ? ('current' as const)
        : ('todo' as const);
  const suggested = state?.suggestedNames ?? [];
  const keyId = sessionInfo.value?.store.keyId;

  return (
    <main class="screen setup" aria-label="First run">
      <div class="setup-column">
        <div class="setup-brand">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 12c2-5 5.5-7.5 9-7.5S19 7 21 12c-2 5-5.5 7.5-9 7.5S5 17 3 12z" />
            <path d="M8 12h8" stroke-dasharray="2 2" />
          </svg>
          <h1 class="setup-name">repo-cloak</h1>
          <span class="muted">first run on this machine · 4 quick choices</span>
        </div>
        <p class="setup-intro">
          Pull a slice of a private repo, rename what gives it away, let an AI work on it, push the
          changes back. Everything stays on this computer.
        </p>
        {error && (
          <div class="new-error setup-error" role="alert">
            {error}
          </div>
        )}
        {!state && !error && <p class="muted">Loading…</p>}
        {state && (
          <>
            <Step
              mark="1"
              state={stepState(0)}
              title="Create your key"
              description="Encrypts manifests, profiles and history. Stored in the OS keychain when one is available."
              value={state.key.exists ? keyLabel(keyId, state.key.storage) : 'No key yet'}
              action={
                state.key.exists ? (
                  <a class={buttonClass('secondary', 'small')} href="#/settings">
                    Settings
                  </a>
                ) : (
                  <Button size="small" disabled={saving} onClick={() => void savePresets()}>
                    Create key
                  </Button>
                )
              }
            />
            <Step
              mark="2"
              state={stepState(1)}
              title="Where cloaks live"
              description="One folder for every cloak, outside your source repos."
              value={state.workspacesRoot ?? 'Not chosen yet'}
              action={
                <Button size="small" onClick={() => setRootOpen(!rootOpen)}>
                  {rootOpen ? 'Close' : state.workspacesRoot ? 'Change' : 'Choose'}
                </Button>
              }
            >
              {rootOpen && (
                <div class="step-form">
                  <Field
                    label="Cloak folder"
                    value={rootDraft}
                    placeholder="~/cloaks"
                    error={rootError ?? undefined}
                    onInput={(event) => setRootDraft(event.currentTarget.value)}
                  />
                  <div class="step-buttons">
                    <Button size="small" onClick={() => setBrowsing(true)}>
                      Browse
                    </Button>
                    <Button
                      size="small"
                      variant="primary"
                      disabled={saving || !rootDraft.trim()}
                      onClick={() => void saveRoot()}
                    >
                      Save folder
                    </Button>
                  </div>
                </div>
              )}
            </Step>
            <Step
              mark="3"
              state={stepState(2)}
              title="Never pull these"
              description="Safe defaults for schemas, migrations, lockfiles, env files and keys."
              value={`${patterns} patterns · ${on.length} presets on`}
              action={
                <Button size="small" onClick={() => setPresetsOpen(!presetsOpen)}>
                  {presetsOpen ? 'Close' : 'Review'}
                </Button>
              }
            >
              {presetsOpen && (
                <div class="step-form">
                  {presets.map((preset) => (
                    <div class="preset" key={preset.id}>
                      <Checkbox
                        label={preset.name}
                        checked={enabled.has(preset.id)}
                        onChange={(event) => {
                          const next = new Set(enabled);
                          if (event.currentTarget.checked) next.add(preset.id);
                          else next.delete(preset.id);
                          setEnabled(next);
                        }}
                      />
                      <span class="preset-patterns">{preset.patterns.join('  ')}</span>
                    </div>
                  ))}
                  <div class="step-buttons">
                    <Button
                      size="small"
                      variant="primary"
                      disabled={saving}
                      onClick={() => void savePresets()}
                    >
                      Save exclusions
                    </Button>
                  </div>
                </div>
              )}
            </Step>
            <Step
              mark="4"
              state={stepState(3)}
              title="First profile"
              description="What to rename. Start blank, import JSON, or start from names suggested by this repo."
              value={
                state.profileCount > 0
                  ? `${state.profileCount} ${state.profileCount === 1 ? 'profile' : 'profiles'}`
                  : suggested.length
                    ? `suggested: ${suggested
                        .slice(0, 3)
                        .map((name) => `${name} → ?`)
                        .join(', ')}`
                    : 'No profile yet'
              }
              action={
                <Button size="small" onClick={() => setProfileOpen(!profileOpen)}>
                  {profileOpen ? 'Close' : 'Set up'}
                </Button>
              }
            >
              {profileOpen && (
                <div class="step-form">
                  <Field
                    label="Profile name"
                    value={profileName}
                    onInput={(event) => setProfileName(event.currentTarget.value)}
                  />
                  {suggested.map((name) => (
                    <Field
                      key={name}
                      label={`Replace ${name} with`}
                      value={replacements[name] ?? ''}
                      onInput={(event) =>
                        setReplacements({ ...replacements, [name]: event.currentTarget.value })
                      }
                    />
                  ))}
                  {profileError && (
                    <p class="field-error" role="alert">
                      {profileError}
                    </p>
                  )}
                  <div class="step-buttons">
                    <a class={buttonClass('secondary', 'small')} href="#/profiles">
                      Import JSON or write rules
                    </a>
                    <Button
                      size="small"
                      variant="primary"
                      disabled={saving || !profileName.trim()}
                      onClick={() => void saveProfile()}
                    >
                      Save profile
                    </Button>
                  </div>
                </div>
              )}
            </Step>
            <div class="setup-foot">
              <Button variant="primary" disabled={saving} onClick={() => void finish()}>
                Finish &amp; cloak this worktree
              </Button>
              <a href="#/">Skip to home</a>
              <span class="muted setup-later">Change any of this later in Settings</span>
            </div>
          </>
        )}
      </div>
      {browsing && (
        <FolderPicker
          initial={rootDraft || undefined}
          title="Choose where cloaks live"
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            setRootDraft(path);
            setBrowsing(false);
          }}
        />
      )}
    </main>
  );
}
