import { useEffect, useState } from 'preact/hooks';
import { loadSupplyChain } from '../../api/client.js';
import type { DashboardSettings, LockedSetting, V2Api } from '../../api/contracts.js';
import { registerCommands } from '../../shell/commands.js';
import { api } from '../../shell/load.js';
import { sessionInfo } from '../../shell/state.js';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  Mono,
  Panel,
  toast,
} from '../../shell/ui/index.js';
import { exportSignedLog } from '../history/audit-actions.js';
import { FolderPicker, LoadError, copyText, errorText, useLoad } from '../repos/shared.js';
import { AiTools } from './ai-tools.js';
import { idleLock, lockTab, startAutoLock } from './auto-lock.js';

// Idle locking has to run on every screen, and only this package owns it.
if (globalThis.document) startAutoLock();

type Patch = V2Api['PUT /api/v2/settings']['body'];
type Draft = {
  workspacesRoot: string;
  commands: string;
  keyStorage: DashboardSettings['security']['keyStorage'];
  autoLock: string;
  retention: string;
  override: boolean;
};
function toDraft(settings: DashboardSettings): Draft {
  return {
    workspacesRoot: settings.workspacesRoot,
    commands: settings.postCreateCommands.join('\n'),
    keyStorage: settings.security.keyStorage,
    autoLock: settings.security.autoLockMinutes?.toString() ?? '',
    retention: settings.security.auditRetentionDays?.toString() ?? '',
    override: settings.security.allowExclusionOverride,
  };
}
const wholeNumber = (text: string) => /^[1-9]\d{0,5}$/.test(text.trim());
export function numberProblem(text: string) {
  return text.trim() && !wholeNumber(text)
    ? 'Use a whole number, or leave empty for none'
    : undefined;
}
const toNumber = (text: string) => (text.trim() ? Number(text.trim()) : null);

/** Only what changed, so an untouched policy-locked field can never be rejected. */
export function changedFields(saved: DashboardSettings, draft: Draft): Patch {
  const before = toDraft(saved);
  const lines = draft.commands
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    ...(draft.workspacesRoot.trim() && draft.workspacesRoot !== before.workspacesRoot
      ? { workspacesRoot: draft.workspacesRoot.trim() }
      : {}),
    ...(draft.commands !== before.commands ? { postCreateCommands: lines } : {}),
    ...(draft.keyStorage !== before.keyStorage ? { keyStorage: draft.keyStorage } : {}),
    ...(draft.autoLock !== before.autoLock ? { autoLockMinutes: toNumber(draft.autoLock) } : {}),
    ...(draft.retention !== before.retention
      ? { auditRetentionDays: toNumber(draft.retention) }
      : {}),
    ...(draft.override !== before.override ? { allowExclusionOverride: draft.override } : {}),
  };
}

const sections = [
  ['general', 'Workspaces'],
  ['security', 'Security'],
  ['exclusions', 'Global exclusions'],
  ['compliance', 'Audit & compliance'],
  ['supply', 'Supply chain'],
  ['integrations', 'AI tools & editor'],
] as const;

function Lock({ on }: { on: boolean }) {
  return on ? <Badge tone="push">policy</Badge> : null;
}

function SupplyChain() {
  const report = useLoad(() => loadSupplyChain(), []);
  const data = report.data;
  return (
    <>
      <LoadError message={report.error} />
      {data && (
        <div class="adm-stats adm-pad">
          <div>
            <div class="adm-stat">{data.directDependencies}</div>
            <div class="adm-meta">direct dependencies</div>
          </div>
          <div>
            <div class="adm-stat">{data.productionPackages}</div>
            <div class="adm-meta">total in tree</div>
          </div>
          <div>
            <div class={`adm-stat${data.installScriptsAllowed ? '' : ' adm-stat-ok'}`}>
              {data.installScriptsAllowed ? 'allowed' : '0'}
            </div>
            <div class="adm-meta">install scripts allowed</div>
          </div>
          <div>
            <div class={`adm-stat${data.pinned ? ' adm-stat-ok' : ''}`}>
              {data.pinned ? 'pinned' : 'not pinned'}
            </div>
            <div class="adm-meta">lockfile{data.integrityHashes ? ' + integrity hashes' : ''}</div>
          </div>
        </div>
      )}
      <div class="adm-flex adm-pad">
        <Button size="small" onClick={() => void copyText('npm run sbom', 'the SBOM command')}>
          Copy SBOM command
        </Button>
        <Button
          size="small"
          onClick={() =>
            void copyText('npm audit --omit=dev --audit-level=moderate', 'the advisory command')
          }
        >
          Copy advisory check
        </Button>
        <span class="adm-note">
          This dashboard makes no outbound calls. Run these in a terminal to check.
        </span>
      </div>
    </>
  );
}

function KeyActions({ onLock }: { onLock: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const store = sessionInfo.value?.store;
  async function refresh() {
    sessionInfo.value = await api().call('GET /api/v2/session');
  }
  async function rotate() {
    setBusy(true);
    try {
      const result = await api().call('POST /api/v2/settings/key/rotate');
      toast(
        result.pending.length
          ? `Key rotated. ${result.pending.length} unreachable cloaks still need the old key.`
          : `Key rotated. ${result.resealed} records resealed.`,
        result.pending.length ? 'info' : 'ok',
      );
      await refresh();
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }
  async function migrate() {
    try {
      await api().call('POST /api/v2/settings/key/migrate', { body: { target: 'keychain' } });
      toast('Key moved to the OS keychain', 'ok');
      await refresh();
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }
  return (
    <div class="adm-flex adm-pad">
      <Button size="small" onClick={() => setConfirming(true)}>
        Rotate key
      </Button>
      {store?.migrationAvailable && (
        <Button size="small" onClick={() => void migrate()}>
          Move key to keychain
        </Button>
      )}
      <Button size="small" variant="danger" onClick={onLock}>
        Lock store now
      </Button>
      <span class="adm-note">
        Locking ends this tab's session. Run repo-cloak for a new link to get back in.
      </span>
      <Dialog
        title="Rotate the store key?"
        open={confirming}
        onClose={() => setConfirming(false)}
        actions={
          <>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => void rotate()}>
              Rotate key
            </Button>
          </>
        }
      >
        <p class="adm-note">
          Reseals the store, cloak manifests and audit log under a new key. Manifests already
          committed to a cloak's Git history stay sealed under the old key.
        </p>
      </Dialog>
    </div>
  );
}

export function SettingsScreen() {
  const loaded = useLoad(() => api().call('GET /api/v2/settings'), []);
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [chain, setChain] = useState<string>();
  useEffect(() => {
    if (loaded.data) setDraft(toDraft(loaded.data));
  }, [loaded.data]);
  useEffect(
    () =>
      registerCommands(() => [
        {
          id: 'lock-store',
          group: 'Actions',
          title: 'Lock store now',
          icon: '■',
          keywords: ['security'],
          run: () => lockTab(),
        },
      ]),
    [],
  );
  const saved = loaded.data;
  const security = saved?.security;
  const isLocked = (field: LockedSetting) => security?.locked.includes(field) ?? false;
  const patch = saved && draft ? changedFields(saved, draft) : {};
  const dirty = Object.keys(patch).length > 0;
  const lockProblem = draft && numberProblem(draft.autoLock);
  const retentionProblem = draft && numberProblem(draft.retention);
  const update = (fields: Partial<Draft>) => draft && setDraft({ ...draft, ...fields });
  async function save() {
    setSaving(true);
    setSaveError(undefined);
    try {
      const next = await api().call('PUT /api/v2/settings', { body: patch });
      loaded.set(next);
      idleLock.set(next.security.autoLockMinutes);
      toast('Settings saved', 'ok');
    } catch (error) {
      setSaveError(errorText(error));
    } finally {
      setSaving(false);
    }
  }
  async function verify() {
    setChain('Checking…');
    try {
      const result = await api().call('POST /api/v2/audit/verify');
      setChain(
        result.ok
          ? `✓ chain verified · ${result.count} events`
          : `✕ broken at line ${result.firstBroken.line}: ${result.firstBroken.reason}`,
      );
    } catch (error) {
      setChain(`✕ ${errorText(error)}`);
    }
  }
  const lockedCount = security?.locked.length ?? 0;
  const policy = security?.policy;
  const store = sessionInfo.value?.store;
  return (
    <main class="screen" aria-label="Settings" data-placeholder="50-admin">
      <header class="adm-head">
        <h1 class="adm-title">Settings</h1>
        {lockedCount > 0 && (
          <Badge tone="push">{lockedCount} fields set by org policy · locked</Badge>
        )}
        <div class="adm-head-end">
          <Button
            variant="primary"
            size="small"
            disabled={!dirty || saving || !!lockProblem || !!retentionProblem}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </header>
      <LoadError message={loaded.error ?? saveError ?? null} />
      <div class="adm-split">
        <nav class="adm-nav" aria-label="Settings sections">
          {/* Buttons, not anchors: the address fragment belongs to the router. */}
          {sections.map(([id, label]) => (
            <button
              key={id}
              type="button"
              class="adm-nav-item"
              onClick={() => document.getElementById(`settings-${id}`)?.scrollIntoView()}
            >
              {label}
            </button>
          ))}
          <a class="adm-nav-item" href="#/profiles">
            Profiles
          </a>
          <a class="adm-nav-item" href="#/repos">
            Known repos
          </a>
        </nav>
        {draft && security && policy && (
          <div class="adm-body adm-settings">
            <div id="settings-general">
              <Panel title="Workspaces">
                <div class="adm-form">
                  <label class="adm-form-label" for="adm-root">
                    Cloak root
                  </label>
                  <div>
                    <span class="adm-root">
                      <input
                        id="adm-root"
                        class="input adm-mono"
                        value={draft.workspacesRoot}
                        onInput={(event) => update({ workspacesRoot: event.currentTarget.value })}
                      />
                      <Button onClick={() => setBrowsing(!browsing)}>Browse</Button>
                    </span>
                    {browsing && (
                      <FolderPicker
                        start={draft.workspacesRoot}
                        onPick={(path) => {
                          update({ workspacesRoot: path });
                          setBrowsing(false);
                        }}
                      />
                    )}
                  </div>
                  <label class="adm-form-label" for="adm-commands">
                    Post-create commands
                  </label>
                  <textarea
                    id="adm-commands"
                    class="adm-area"
                    placeholder="One command per line"
                    value={draft.commands}
                    onInput={(event) => update({ commands: event.currentTarget.value })}
                  />
                </div>
              </Panel>
            </div>
            <div id="settings-security">
              <Panel title="Security">
                <div class="adm-setting">
                  <span>
                    Master key storage
                    <div class="adm-meta">
                      Now: {store?.storage ?? 'not created yet'}
                      {store?.keyId ? ` · ${store.keyId}` : ''}
                      {store?.rotationPending ? ' · rotation pending' : ''}
                    </div>
                  </span>
                  <select
                    class="adm-select"
                    aria-label="Key storage for new installs"
                    value={draft.keyStorage}
                    onChange={(event) =>
                      update({
                        keyStorage: event.currentTarget.value as Draft['keyStorage'],
                      })
                    }
                  >
                    <option value="auto">Auto</option>
                    <option value="keychain">OS keychain</option>
                    <option value="file">Key file</option>
                  </select>
                </div>
                <div class="adm-setting">
                  <span>
                    Auto-lock store <Lock on={isLocked('autoLockMinutes')} />
                    <div class="adm-meta">Minutes idle before this tab ends its session</div>
                  </span>
                  <Field
                    label={<span class="sr-only">Auto-lock minutes</span>}
                    inputMode="numeric"
                    placeholder="off"
                    value={draft.autoLock}
                    error={lockProblem}
                    disabled={isLocked('autoLockMinutes')}
                    onInput={(event) => update({ autoLock: event.currentTarget.value })}
                  />
                </div>
                <div class="adm-setting">
                  <span>
                    Override exclusions <Lock on={isLocked('allowExclusionOverride')} />
                    <div class="adm-meta">Pull a file a rule blocks, once, with a reason</div>
                  </span>
                  <Checkbox
                    label="Allow"
                    checked={draft.override}
                    disabled={isLocked('allowExclusionOverride')}
                    onChange={(event) => update({ override: event.currentTarget.checked })}
                  />
                </div>
                <div class="adm-setting">
                  <span>
                    Network
                    <div class="adm-meta">
                      Dashboard listens on 127.0.0.1 only, token per session, no telemetry
                    </div>
                  </span>
                  <span class="adm-value adm-value-ok">loopback only</span>
                </div>
                <div class="adm-setting">
                  <span>
                    Wipe on delete
                    <div class="adm-meta">
                      Deleting a cloak removes its files but does not overwrite them first
                    </div>
                  </span>
                  <span class="adm-value">not available</span>
                </div>
                <KeyActions onLock={() => lockTab()} />
              </Panel>
            </div>
            <div id="settings-exclusions">
              <Panel
                title={
                  <>
                    Global exclusions{' '}
                    <span class="adm-meta">
                      set by org policy · cannot be loosened by a profile
                    </span>
                  </>
                }
              >
                <div class="adm-pad">
                  {security.lockedExclusions.length ? (
                    <div class="adm-chips">
                      {security.lockedExclusions.map((pattern) => (
                        <span key={pattern} class="adm-chip adm-chip-locked">
                          {pattern}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p class="adm-note">No org-wide exclusions are set.</p>
                  )}
                  <p class="adm-note">
                    Add your own per repo in <a href="#/repos">Known repos</a> or per profile in{' '}
                    <a href="#/profiles">Profiles</a>.
                  </p>
                </div>
              </Panel>
            </div>
            <div id="settings-compliance">
              <Panel title="Audit & compliance">
                <div class="adm-cols">
                  <div class="adm-pad">
                    <Field
                      label={
                        <>
                          Keep audit log, days <Lock on={isLocked('auditRetentionDays')} />
                        </>
                      }
                      inputMode="numeric"
                      placeholder="forever"
                      value={draft.retention}
                      error={retentionProblem}
                      disabled={isLocked('auditRetentionDays')}
                      onInput={(event) => update({ retention: event.currentTarget.value })}
                    />
                    <p class="adm-note">
                      Append-only, hash-chained, sealed. Records who, when, which files, which
                      rules, which key. Never file contents.
                    </p>
                    <div class="adm-flex">
                      <Button size="small" onClick={() => void verify()}>
                        Verify chain
                      </Button>
                      <Button size="small" onClick={() => void exportSignedLog()}>
                        Export for auditor
                      </Button>
                    </div>
                    {chain && (
                      <p class="adm-note" role="status">
                        {chain}
                      </p>
                    )}
                  </div>
                  <div class="adm-pad">
                    <div>Org policy file</div>
                    <Mono muted>{policy.path ?? 'none on this machine'}</Mono>
                    {policy.status === 'active' && (
                      <p class="adm-note">
                        <Badge tone="ok">
                          ✓ {policy.signed ? 'signature valid' : 'active, unsigned'}
                        </Badge>
                      </p>
                    )}
                    {policy.status === 'invalid' && (
                      <p class="adm-note">
                        <Badge tone="blocked">✕ invalid</Badge> Create, pull and agent requests are
                        blocked until it is fixed.
                      </p>
                    )}
                    {policy.message && <p class="adm-note">{policy.message}</p>}
                  </div>
                </div>
                <p class="adm-note adm-pad">
                  Gives you the evidence for an ISO/IEC 27001 Annex A review (access, logging,
                  cryptography, secure development). The certificate itself belongs to your
                  organisation, not to the tool.
                </p>
              </Panel>
            </div>
            <div id="settings-supply">
              <Panel title="Runs locally · supply chain">
                <SupplyChain />
              </Panel>
            </div>
            <div id="settings-integrations">
              <Panel title="AI tools & editor">
                <AiTools />
              </Panel>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
