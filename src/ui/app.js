/* global document, window, sessionStorage, history, location, URLSearchParams, fetch, crypto, structuredClone, localStorage, matchMedia */
const $ = (id) => document.getElementById(id);
const on = (el, ev, fn) => el.addEventListener(ev, fn);
const attr = (el, k, v) => el.setAttribute(k, v);
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  attr(svg, 'viewBox', '0 0 24 24');
  attr(svg, 'class', 'icon');
  attr(svg, 'aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  attr(
    path,
    'd',
    {
      cloak: 'M6 21 8 9a4 4 0 0 1 8 0l2 12-6-3-6 3zM9 10q3-3 6 0M10 13h4',
      repo: 'M4 4h16v16H4zM8 4v16M12 8h4',
      pull: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
      push: 'M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5',
      plus: 'M12 5v14M5 12h14',
      search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
      refresh: 'M20 7v5h-5M20 12a8 8 0 1 0-2 5',
      moon: 'M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10',
      sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
      history: 'M3 4v5h5M3 9a9 9 0 1 1 0 6M12 7v5l3 2',
      trash: 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6',
    }[name],
  );
  svg.append(path);
  return svg;
}
for (const element of document.querySelectorAll('[data-icon]'))
  element.prepend(icon(element.dataset.icon));
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let savedTheme;
try {
  savedTheme = localStorage.getItem('cloak-theme');
} catch {
  /* Storage may be disabled. */
}
function applyTheme() {
  const dark = savedTheme ? savedTheme === 'dark' : systemTheme.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme-toggle').replaceChildren(icon(dark ? 'sun' : 'moon'));
  $('theme-toggle').title = dark ? 'Light mode' : 'Dark mode';
  attr($('theme-toggle'), 'aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}
on($('theme-toggle'), 'click', () => {
  savedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('cloak-theme', savedTheme);
  } catch {
    /* Keep the theme for this page. */
  }
  applyTheme();
});
on(systemTheme, 'change', applyTheme);
applyTheme();

let params = new URLSearchParams(location.hash.slice(1));
const incomingToken = params.get('token');
if (incomingToken) sessionStorage.setItem('cloak-token', incomingToken);
let token = sessionStorage.getItem('cloak-token');
params.delete('token');
history.replaceState(null, '', `/#${params}`);
let settings = {};
let repos = [];
let profiles = [];
let repoId = params.get('repo') ?? '';
let workspaceId = params.get('workspace');
let schema;
let editing;
let raw = false;
const checked = new Set();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(text, action, className = 'quiet') {
  const element = node('button', text, className);
  element.type = 'button';
  on(element, 'click', () => safely(action));
  return element;
}
let syncing = false;
function busy(value) {
  syncing = value;
  attr(document.querySelector('.app-frame'), 'aria-busy', String(value));
  for (const button of document.querySelectorAll('.sync-btn')) button.disabled = value;
}
function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'error' : '';
  $('notice').hidden = false;
}
async function safely(action) {
  try {
    await action();
  } catch (error) {
    notice(error.message, true);
  }
}
async function api(path, method = 'GET', body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}
function scope() {
  return repoId ? { kind: 'repo', repoId } : { kind: 'global' };
}
function reference(profile) {
  return { id: profile.id, scope: profile.scope };
}
function key(profile) {
  return `${profile.scope.kind}:${profile.id}`;
}
function remember() {
  const hash = new URLSearchParams();
  if (repoId) hash.set('repo', repoId);
  if (workspaceId) hash.set('workspace', workspaceId);
  if (params.get('worktree')) hash.set('worktree', params.get('worktree'));
  history.replaceState(null, '', `/#${hash}`);
}
function empty(title, description, command) {
  const element = node('div', undefined, 'empty');
  element.append(node('h2', title), node('p', description));
  if (command) element.append(node('code', command));
  return element;
}
async function reload() {
  repos = await api('repos');
  settings = await api('settings');
  if (!repos.some((repo) => repo.id === repoId)) {
    repoId = repos[0]?.id ?? '';
    workspaceId = null;
    remember();
  }
  renderNavigation();
  await renderWorkspaces();
  await loadProfiles();
  if (wizard) $('ws-view').hidden = true;
}
function renderNavigation() {
  $('repos').replaceChildren();
  $('repository-count').textContent = String(repos.length);
  const add = (name, id, count, path) => {
    const item = button(undefined, () => selectRepo(id), 'repo-item');
    item.append(
      icon('repo'),
      node('span', name, 'repo-name'),
      node('span', String(count), 'repo-count'),
    );
    item.classList.toggle('active', repoId === id);
    if (repoId === id) attr(item, 'aria-current', 'page');
    if (path) item.title = path;
    $('repos').append(item);
  };
  for (const repo of repos) add(repo.name, repo.id, repo.workspaces.length, repo.path);
  const selected = repos.find((repo) => repo.id === repoId);
  $('title').textContent = selected?.name ?? 'Workspaces';
  $('title').title = selected ? `${selected.name} · ${selected.path}` : '';
  $('new-ws').hidden = !selected;
  attr($('new-ws'), 'aria-label', `Create cloak workspace · ${selected?.name ?? ''}`);
  $('new-ws').onclick = () => safely(() => startWizard(selected, null, 'create'));
}
async function selectRepo(id) {
  if (!canLeaveEditor()) return;
  if (wizard && !(await closeWizard())) return;
  $('settings-view').hidden = true;
  $('profile-view').hidden = true;
  $('ws-view').hidden = false;
  repoId = id;
  workspaceId = null;
  checked.clear();
  remember();
  renderNavigation();
  await renderWorkspaces();
  await loadProfiles();
}
async function renderWorkspaces() {
  const view = $('ws-view');
  view.replaceChildren();
  const selected = repoId ? repos.filter((repo) => repo.id === repoId) : repos;
  if (!selected.some((repo) => repo.workspaces.length)) {
    view.append(
      empty(
        'Your cloak workspaces',
        'Create a workspace to start syncing.',
        repoId ? undefined : 'Run repo-cloak ui in your source repository.',
      ),
    );
    return;
  }
  for (const repo of selected) {
    for (const workspace of repo.workspaces) {
      const card = node('article', undefined, 'panel ws-card');
      const heading = node('div', undefined, 'card-head');
      const identity = node('div', undefined, 'ws-identity');
      const name = node('h2', workspace.name);
      name.title = workspace.name;
      identity.append(name);
      heading.append(identity);
      if (workspace.missing) heading.append(node('span', 'Missing on disk', 'pill pill-muted'));
      const meta = node('p', undefined, 'ws-meta');
      if (!repoId) meta.append(node('span', repo.name));
      const used = node(
        'time',
        `Last used ${new Date(workspace.lastUsedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
      );
      used.dateTime = workspace.lastUsedAt;
      used.title = new Date(workspace.lastUsedAt).toLocaleString();
      meta.append(used);
      const badges = node('div', undefined, 'badges');
      attr(badges, 'aria-label', 'Applied profiles');
      for (const profile of workspace.lastProfiles) {
        const pill = node('span', profile);
        pill.title = profile;
        badges.append(pill);
      }
      card.append(heading, meta, badges);
      const remove = button(
        '',
        async () => {
          if (
            !window.confirm(
              `Delete this workspace entirely?\n\n${workspace.path}\n\nDeletes files, Git history and unsynced edits. Source stays intact.`,
            )
          )
            return;
          remove.disabled = true;
          try {
            await api(`workspaces/${repo.id}/${encodeURIComponent(workspace.id)}`, 'DELETE', {
              path: workspace.path,
              confirm: true,
            });
            if (workspaceId === workspace.id) workspaceId = null;
            remember();
            await reload();
            notice('Workspace deleted');
          } finally {
            remove.disabled = false;
          }
        },
        'quiet ws-more trash',
      );
      remove.append(icon('trash'));
      remove.title = 'Delete';
      attr(remove, 'aria-label', `Delete workspace ${workspace.name}`);
      heading.append(remove);
      view.append(card);

      if (!workspace.missing) {
        const detailBox = node('div', undefined, 'ws-details');
        detailBox.hidden = true;
        const location = node('dl', undefined, 'ws-location');
        location.append(
          node('dt', 'Location'),
          node('dd', workspace.path),
          node('dt', 'Profiles'),
          node('dd', workspace.lastProfiles.join(', ') || 'None recorded'),
        );
        const content = node('div', undefined, 'ws-detail');
        const info = node('details', undefined, 'ws-info');
        info.append(node('summary', 'Workspace details'), location);
        detailBox.append(content, info);
        const show = button(
          'History',
          async () => {
            if (!detailBox.hidden) {
              detailBox.hidden = true;
              attr(show, 'aria-expanded', 'false');
              workspaceId = null;
              remember();
              return;
            }
            show.disabled = true;
            try {
              const detail = await api(`workspaces/${repo.id}/${encodeURIComponent(workspace.id)}`);
              workspaceId = workspace.id;
              remember();
              renderWorkspaceDetail(content, detail);
              detailBox.hidden = false;
              attr(show, 'aria-expanded', 'true');
            } finally {
              show.disabled = false;
            }
          },
          'quiet ws-more',
        );
        show.prepend(icon('history'));
        attr(show, 'aria-label', 'View status & history');
        attr(show, 'aria-expanded', 'false');
        const syncBtn = (symbol, label, intent, cls) => {
          const b = button(
            undefined,
            () => quickSync(repo, workspace, intent, b),
            `sync-btn ${cls}`,
          );
          b.disabled = syncing;
          attr(b, 'aria-label', label);
          b.title = intent === 'refresh' ? 'Source → cloak workspace' : 'Cloak workspace → source';
          b.append(
            icon(symbol),
            node('span', intent === 'refresh' ? 'Pull files' : 'Push changes'),
          );
          return b;
        };
        const actions = node('div', undefined, 'toolbar card-tools');
        actions.append(
          syncBtn('pull', 'Pull from source', 'refresh', 'pull-btn'),
          syncBtn('push', 'Push to source', 'restore', 'push-btn'),
          show,
        );
        card.append(actions, detailBox);
        if (workspaceId === workspace.id) {
          detailBox.hidden = false;
          attr(show, 'aria-expanded', 'true');
          content.append(node('p', 'Loading history…', 'muted'));
          try {
            renderWorkspaceDetail(
              content,
              await api(`workspaces/${repo.id}/${encodeURIComponent(workspace.id)}`),
            );
          } catch (error) {
            content.replaceChildren(node('p', error.message, 'muted'));
          }
        }
      }
    }
  }
}
function renderWorkspaceDetail(content, detail) {
  content.replaceChildren();
  const changed = ['modified', 'added', 'deleted'].reduce(
    (sum, kind) => sum + detail.status[kind].length,
    0,
  );
  content.append(
    node(
      'p',
      `${detail.trackedFiles} tracked files · ${changed ? `${changed} changed` : 'No workspace changes'}`,
      'ws-status',
    ),
  );
  const changes = Object.entries(detail.status).filter(([kind]) =>
    ['modified', 'added', 'deleted'].includes(kind),
  );
  if (changes.some(([, paths]) => paths.length)) {
    const details = node('details');
    details.append(node('summary', 'Changed files'));
    const list = node('ul');
    for (const [kind, paths] of changes)
      for (const path of paths) list.append(node('li', `${kind}: ${path}`));
    details.append(list);
    content.append(details);
  }
  const history = node('section', undefined, 'ws-history');
  history.append(node('h3', `Pull history · ${detail.history.length}`));
  const list = node('ol', undefined, 'history');
  const older = node('details');
  older.append(node('summary', `Earlier pulls · ${detail.history.length - 3}`));
  const past = node('ol', undefined, 'history');
  older.append(past);
  for (const [index, pull] of detail.history.entries()) {
    const row = node('li');
    const time = node('time', new Date(pull.at).toLocaleString());
    time.dateTime = pull.at;
    row.append(time, node('span', `${pull.selection.files} files`));
    row.title = `${pull.selection.commits} commits${pull.selection.working ? ' · working changes' : ''}`;
    (index < 3 ? list : past).append(row);
  }
  if (!detail.history.length) history.append(node('p', 'No pulls yet.', 'muted'));
  history.append(list);
  if (detail.history.length > 3) history.append(older);
  content.append(history);
}
async function loadProfiles() {
  profiles = await api(`profiles${repoId ? `?repoId=${repoId}` : ''}`);
  $('profiles').replaceChildren();
  if (!profiles.length)
    $('profiles').append(empty('Rules you can reuse', 'Anonymize names and redact secrets.'));
  for (const profile of profiles) {
    const row = node('div', undefined, 'prof-row');
    const label = node('label');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked.has(key(profile));
    on(checkbox, 'change', () =>
      checkbox.checked ? checked.add(key(profile)) : checked.delete(key(profile)),
    );
    label.append(
      checkbox,
      node('span', profile.profile.name),
      node('small', `${profile.scope.kind} · ${profile.profile.rules.length} rules`),
    );
    row.append(
      label,
      button('Edit', () => openEditor(profile)),
    );
    $('profiles').append(row);
  }
}
function canLeaveEditor() {
  if ($('editor').hidden) return true;
  if (!window.confirm('Close the editor and discard unsaved changes?')) return false;
  $('editor').hidden = true;
  $('notice').hidden = true;
  return true;
}
function openEditor(saved) {
  if (!canLeaveEditor()) return;
  editing = saved
    ? structuredClone(saved)
    : {
        scope: scope(),
        profile: { kind: 'profile', schemaVersion: 1, name: '', rules: [], exclude: [] },
      };
  $('editor').hidden = false;
  $('editor-title').textContent = saved ? `Edit ${saved.profile.name}` : 'New profile';
  $('delete-profile').hidden = !saved;
  $('scope').replaceChildren();
  const global = node('option', 'All repositories');
  global.value = 'global';
  $('scope').append(global);
  if (repoId) {
    const repo = node('option', 'This repository');
    repo.value = 'repo';
    $('scope').append(repo);
  }
  $('scope').value = editing.scope.kind;
  $('scope').disabled = !!saved;
  setEditorMode(false);
  $('profile-name').focus();
}
function readForm() {
  if (raw) editing.profile = JSON.parse($('profile-json').value);
  else {
    editing.profile.name = $('profile-name').value;
    editing.profile.description = $('profile-description').value;
    // Empty lists become undefined, which JSON leaves out of the saved profile.
    const exclude = lines('profile-exclude');
    const include = lines('profile-include');
    editing.profile = {
      ...editing.profile,
      exclude: exclude.length ? exclude : undefined,
      include: include.length ? include : undefined,
    };
  }
}
const splitLines = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const lines = (id) => splitLines($(id).value);
function setTab(id) {
  for (const tab of ['workspaces-tab', 'profiles-tab', 'settings-button'])
    $(tab).classList.toggle('active', tab === id);
}
function patternList(value) {
  return value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
}
function setEditorMode(json) {
  if (
    !json &&
    (!editing.profile ||
      typeof editing.profile !== 'object' ||
      !Array.isArray(editing.profile.rules) ||
      !patternList(editing.profile.exclude) ||
      !patternList(editing.profile.include) ||
      editing.profile.rules.some(
        (rule) => !rule || !['literal', 'regex', 'secret'].includes(rule.type),
      ))
  )
    throw new Error('Invalid profile JSON. Correct it before using the form.');
  raw = json;
  $('form-fields').hidden = json;
  $('json-field').hidden = !json;
  $('profile-name').required = !json;
  $('form-tab').classList.toggle('active', !json);
  $('json-tab').classList.toggle('active', json);
  if (json) $('profile-json').value = JSON.stringify(editing.profile, null, 2);
  else renderForm();
}
function renderForm() {
  $('profile-name').value = editing.profile.name ?? '';
  $('profile-description').value = editing.profile.description ?? '';
  $('profile-exclude').value = (editing.profile.exclude ?? []).join('\n');
  $('profile-include').value = (editing.profile.include ?? []).join('\n');
  $('rules').replaceChildren();
  if (!Array.isArray(editing.profile.rules)) throw new Error('Profile rules must be an array');
  for (const [index, rule] of editing.profile.rules.entries()) renderRule(rule, index);
}
function field(parent, text, value, change, values) {
  const label = node('label', text);
  const input = node(values ? 'select' : 'input');
  if (values)
    for (const value of values) {
      const option = node('option', value);
      option.value = value;
      input.append(option);
    }
  input.value = value ?? '';
  on(input, 'input', () => change(input.value));
  label.append(input);
  parent.append(label);
}
function renderRule(rule, index) {
  const element = node('div', undefined, 'rule');
  const toolbar = node('div', undefined, 'toolbar wiz-foot');
  toolbar.append(
    node('h3', `Rule ${index + 1}`),
    button('Remove', () => {
      readForm();
      editing.profile.rules.splice(index, 1);
      renderForm();
    }),
  );
  element.append(toolbar);
  const grid = node('div', undefined, 'rule-grid');
  const variants = schema.properties.rules.items.oneOf;
  field(grid, 'Rule id', rule.id, (value) => (rule.id = value));
  field(
    grid,
    'Type',
    rule.type,
    (value) => {
      readForm();
      editing.profile.rules[index] = {
        id: rule.id,
        type: value,
        ...(value === 'secret' ? { detector: 'api-key' } : { match: '', replace: '' }),
      };
      renderForm();
    },
    variants.map((variant) => variant.properties.type.const),
  );
  if (rule.type === 'secret')
    field(grid, 'Detector id', rule.detector, (value) => (rule.detector = value));
  else {
    field(
      grid,
      rule.type === 'regex' ? 'Regular expression' : 'Original name',
      rule.match,
      (value) => (rule.match = value),
    );
    field(
      grid,
      rule.type === 'regex' ? 'Replacement' : 'Anonymous name',
      rule.replace,
      (value) => (rule.replace = value),
    );
    if (rule.type === 'literal') {
      const literal = variants.find((variant) => variant.properties.type.const === 'literal');
      field(
        grid,
        'Boundary',
        rule.boundary ?? 'token',
        (value) => (rule.boundary = value),
        literal.properties.boundary.enum,
      );
    } else field(grid, 'Flags (g is automatic)', rule.flags ?? '', (value) => (rule.flags = value));
  }
  element.append(grid);
  $('rules').append(element);
}
$('workspaces-tab').onclick = () => {
  $('settings-view').hidden = true;
  if (wizard?.running) return;
  if (wizard) {
    void safely(showWizard);
    return;
  }
  $('ws-view').hidden = false;
  $('profile-view').hidden = true;
  setTab('workspaces-tab');
};
$('profiles-tab').onclick = () => {
  $('settings-view').hidden = true;
  if (wizard?.running) return;
  if (wizard) {
    $('wizard').hidden = true;
    $('resume').hidden = false;
  }
  $('ws-view').hidden = true;
  $('profile-view').hidden = false;
  setTab('profiles-tab');
};
on($('global-search'), 'input', (event) => {
  const query = event.target.value.trim().toLowerCase();
  for (const item of document.querySelectorAll('#ws-view article, #profiles .prof-row'))
    item.hidden = !!query && !item.textContent.toLowerCase().includes(query);
});
$('new-profile').onclick = () => safely(() => openEditor());
$('close-editor').onclick = canLeaveEditor;
$('form-tab').onclick = () =>
  safely(() => {
    readForm();
    setEditorMode(false);
  });
$('json-tab').onclick = () =>
  safely(() => {
    readForm();
    setEditorMode(true);
  });
$('add-rule').onclick = () =>
  safely(() => {
    readForm();
    editing.profile.rules.push({
      id: `rule-${crypto.randomUUID().slice(0, 8)}`,
      type: 'literal',
      match: '',
      replace: '',
    });
    renderForm();
  });
$('refresh').onclick = () => safely(reload);
$('check-profiles').onclick = () =>
  safely(async () => {
    const selected = profiles.filter((profile) => checked.has(key(profile))).map(reference);
    if (!selected.length) throw new Error('Select profiles to check together');
    const result = await api('profiles/check', 'POST', selected);
    notice(`${result.profiles} profiles are compatible · ${result.rules} active rules`);
  });
on($('editor'), 'submit', (event) => {
  event.preventDefault();
  void safely(async () => {
    readForm();
    const request = {
      ...editing,
      scope: editing.id
        ? editing.scope
        : $('scope').value === 'repo'
          ? scope()
          : { kind: 'global' },
    };
    const saved = await api('profiles', 'POST', request);
    await loadProfiles();
    $('editor').hidden = true;
    if (wizard) {
      wizard.selectedProfiles.add(key(saved));
      await showWizard();
    }
    notice(`Saved ${saved.profile.name}`);
  });
});
$('delete-profile').onclick = () =>
  safely(async () => {
    if (
      !window.confirm(`Delete profile ${editing.profile.name}? Workspaces keep their saved rules.`)
    )
      return;
    await api('profiles', 'DELETE', reference(editing));
    await loadProfiles();
    $('editor').hidden = true;
    notice('Profile deleted');
  });
on(window, 'hashchange', () =>
  safely(async () => {
    if (wizard?.running || !canLeaveEditor()) {
      remember();
      return;
    }
    await closeWizard();
    params = new URLSearchParams(location.hash.slice(1));
    token = params.get('token') || token;
    if (token) sessionStorage.setItem('cloak-token', token);
    params.delete('token');
    repoId = params.get('repo') ?? '';
    workspaceId = params.get('workspace');
    launchWorktree = params.get('worktree');
    remember();
    await reload();
    await maybeStartSetup();
  }),
);
on(window, 'beforeunload', (event) => {
  if (!$('editor').hidden) event.preventDefault();
});
void safely(async () => {
  if (!token) throw new Error('Run repo-cloak ui to start an authenticated session.');
  schema = await api('schema/profile');
  await reload();
  if (!sessionStorage.getItem('cloak-operation')) await maybeStartSetup();
  const saved = sessionStorage.getItem('cloak-operation');
  if (saved) {
    try {
      await monitorOperation(JSON.parse(saved));
    } catch (error) {
      sessionStorage.removeItem('cloak-operation');
      notice(`${error.message}. Refresh status before retrying.`, true);
    }
  }
});

let wizard;
let wizardGeneration = 0;
let launchWorktree = params.get('worktree');
function labeled(parent, title, tag = 'input', value = '') {
  const label = node('label', title);
  const input = node(tag);
  input.value = value;
  label.append(input);
  parent.append(label);
  return input;
}
function choice(parent, title, value, options) {
  const select = labeled(parent, title, 'select');
  for (const [id, text] of options) {
    const option = node('option', text);
    option.value = id;
    select.append(option);
  }
  select.value = value;
  return select;
}
function tick(parent, text, value = false) {
  const label = node('label', undefined, 'check-line');
  const input = node('input');
  input.type = 'checkbox';
  input.checked = value;
  label.append(input, node('span', text));
  parent.append(label);
  return input;
}
async function maybeStartSetup() {
  const repo = repos.find((repo) => repo.id === repoId);
  if (repo && launchWorktree && !repo.workspaces.length) await startWizard(repo, null, 'create');
}
async function loadSyncContext(repo, workspace) {
  const [trees, detail] = await Promise.all([
    api(`repos/${repo.id}/worktrees`),
    workspace ? api(`workspaces/${repo.id}/${encodeURIComponent(workspace.id)}`) : null,
  ]);
  if (!trees.length) throw new Error('No available worktrees');
  const worktree =
    trees.find((tree) => tree.path === launchWorktree)?.path ??
    trees.find((tree) => tree.branch === detail?.targetBranch)?.path ??
    trees[0].path;
  return { trees, detail, worktree };
}
async function quickSync(repo, workspace, intent, trigger) {
  if (wizard?.running || syncing) return;
  busy(true);
  trigger?.classList.add('syncing');
  notice(intent === 'refresh' ? 'Pulling files…' : 'Pushing changes…');
  try {
    const { worktree } = await loadSyncContext(repo, workspace);
    const preview = await api('sync/preview', 'POST', {
      intent,
      repoId: repo.id,
      workspaceId: workspace.id,
      worktree,
    });
    if (!preview.canApply) {
      await api(`sync/${preview.operationId}`, 'DELETE');
      await startWizard(repo, workspace, intent);
      notice('Review changes before syncing.');
      return;
    }
    const saved = { operationId: preview.operationId, repoId: repo.id };
    sessionStorage.setItem('cloak-operation', JSON.stringify(saved));
    const state = await api(`sync/${preview.operationId}/apply`, 'POST', {
      deletions: true,
      profiles: true,
      force: !!preview.forced,
    });
    await monitorOperation(saved, state);
  } finally {
    busy(false);
    trigger?.classList.remove('syncing');
  }
}
async function startWizard(repo, workspace, intent) {
  if (!canLeaveEditor()) return;
  if (wizard && !(await closeWizard())) return;
  const { trees, detail, worktree } = await loadSyncContext(repo, workspace);
  repoId = repo.id;
  workspaceId = workspace?.id ?? null;
  remember();
  await loadProfiles();
  wizard = {
    repo,
    workspace,
    intent,
    trees,
    step: 0,
    worktree,
    selectedProfiles: new Set(
      profiles
        .filter((profile) =>
          detail?.profileRefs.some(
            (ref) => ref.id === profile.id && ref.scope.kind === profile.scope.kind,
          ),
        )
        .map(key),
    ),
    files: '',
    commits: '',
    working: false,
    destination: '',
    policy: 'block',
    root:
      settings.workspacesRoot ||
      repo.path.slice(0, Math.max(repo.path.lastIndexOf('/'), repo.path.lastIndexOf('\\'))),
    commands: (settings.postCreateCommands ?? []).join('\n'),
    saveDefaults: true,
  };
  renderNavigation();
  await showWizard();
}
async function closeWizard() {
  if (wizard?.running) return false;
  if (wizard?.preview) await api(`sync/${wizard.preview.operationId}`, 'DELETE');
  wizard = null;
  wizardGeneration++;
  $('wizard').hidden = true;
  $('resume').hidden = true;
  $('ws-view').hidden = false;
  return true;
}
async function renderSelection(body, current, generation) {
  body.classList.add('wiz-split');
  const active = () => wizard === current && wizardGeneration === generation;
  const paths = new Set(current.files.split('\n').filter(Boolean));
  const commits = new Set(current.commits.split('\n').filter(Boolean));
  const browserPane = node('div', undefined, 'sel-pane');
  const tabs = node('div', undefined, 'sel-tabs');
  attr(tabs, 'role', 'tablist');
  attr(tabs, 'aria-label', 'Select code by');
  const panels = new Map();
  const controls = new Map();
  const summary = node('section', undefined, 'sel-summary');
  attr(summary, 'aria-label', 'Selected code');
  browserPane.append(tabs);
  for (const [id, title] of [
    ['files', 'Files & folders'],
    ['working', 'Uncommitted changes'],
    ['commits', 'Commits'],
  ]) {
    const panel = node('section', undefined, 'sel-panel');
    panel.id = `selection-${id}`;
    attr(panel, 'role', 'tabpanel');
    attr(panel, 'aria-label', title);
    const control = button(title, () => {
      current.selectionTab = id;
      selectTab();
    });
    attr(control, 'role', 'tab');
    attr(control, 'aria-controls', panel.id);
    controls.set(id, control);
    panels.set(id, panel);
    tabs.append(control);
    browserPane.append(panel);
  }
  function selectTab() {
    for (const [id, panel] of panels) {
      panel.hidden = id !== (current.selectionTab ?? 'files');
      attr(controls.get(id), 'aria-selected', String(!panel.hidden));
      controls.get(id).tabIndex = panel.hidden ? -1 : 0;
    }
  }
  selectTab();
  // Arrow keys follow the standard tab interaction; tab panels retain their selections.
  on(tabs, 'keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const ids = [...controls.keys()];
    const index = ids.indexOf(current.selectionTab ?? 'files');
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? ids.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    current.selectionTab = ids[next];
    selectTab();
    controls.get(ids[next]).focus();
  });
  const filePanel = panels.get('files');
  const fileBar = node('div', undefined, 'file-bar');
  const search = labeled(fileBar, 'Search files across the repository');
  search.type = 'search';
  search.placeholder = 'Search by file name or path…';
  search.value = current.fileQuery ?? '';
  const respectIgnore = tick(
    fileBar,
    'Respect Git ignore rules',
    current.respectGitIgnore !== false,
  );
  const navigation = node('span', '', 'muted file-count');
  const listing = node('div', undefined, 'choices tree');
  const loading = node('p', '', 'muted status-line');
  attr(loading, 'role', 'status');
  filePanel.append(fileBar, loading, listing);
  const workingPanel = panels.get('working');
  workingPanel.append(node('p', 'Staged, unstaged, and untracked files.', 'muted'));
  const working = tick(workingPanel, 'Include working changes', current.working);
  const workingList = node('div', undefined, 'choices');
  workingPanel.append(workingList);
  const commitPanel = panels.get('commits');
  const commitCount = node('p');
  commitPanel.append(
    node('p', 'Commit paths use current worktree contents.', 'muted'),
    commitCount,
  );
  let recentCommits = [];
  const buildTree = (files) => {
    const root = { children: new Map(), files: [], descendants: [], directories: new Map() };
    for (const path of files) {
      const parts = path.split('/');
      let branch = root;
      let prefix = '';
      branch.descendants.push(path);
      for (const part of parts.slice(0, -1)) {
        prefix = prefix ? prefix + '/' + part : part;
        if (!branch.children.has(part)) {
          const child = { children: new Map(), files: [], descendants: [] };
          branch.children.set(part, child);
          root.directories.set(prefix, child);
        }
        branch = branch.children.get(part);
        branch.descendants.push(path);
      }
      branch.files.push(path);
    }
    return root;
  };
  const selected = () => {
    current.files = [...paths].join('\n');
    current.commits = [...commits].join('\n');
    current.working = working.checked;
    summary.replaceChildren(
      node(
        'h3',
        `${paths.size} paths · ${commits.size} commits${working.checked ? ' · working changes included' : ''}`,
      ),
    );
    if (!paths.size && !commits.size && !working.checked)
      summary.append(
        node(
          'p',
          current.intent === 'refresh'
            ? 'Reuse the workspace’s tracked files.'
            : 'Search, browse, or choose changes above.',
          'muted',
        ),
      );
    const chips = node('div', undefined, 'sel-chips tree');
    const drawSel = (branch, parent, prefix = '') => {
      for (const [name, child] of branch.children) {
        const group = node('div', undefined, 'tree-folder');
        const row = node('div', undefined, 'tree-row');
        row.append(
          node('span', '▾', 'expander'),
          node('span', name + '/', 'sel-name'),
          node('span', String(child.descendants.length), 'muted'),
        );
        const children = node('div', undefined, 'branches');
        drawSel(child, children, prefix + name + '/');
        group.append(row, children);
        parent.append(group);
      }
      for (const path of branch.files) {
        const row = node('div', undefined, 'tree-row leaf');
        const label = node('span', undefined, 'sel-name');
        if (prefix) label.append(node('span', prefix, 'sr-only'));
        label.append(path.split('/').at(-1));
        const rm = button(
          '×',
          () => {
            paths.delete(path);
            selected();
          },
          'sel-rm quiet',
        );
        attr(rm, 'aria-label', `Remove path: ${path}`);
        row.append(label, rm);
        parent.append(row);
      }
    };
    drawSel(buildTree([...paths].sort()), chips);
    for (const value of commits) {
      const row = node('div', undefined, 'tree-row');
      const rm = button(
        '×',
        () => {
          commits.delete(value);
          selected();
        },
        'sel-rm quiet',
      );
      attr(rm, 'aria-label', `Remove commit: ${value}`);
      row.append(node('span', `commit ${value.slice(0, 8)}`, 'sel-name'), rm);
      chips.append(row);
    }
    summary.append(chips);
    commitCount.textContent = `${commits.size} commits selected`;
    for (const input of body.querySelectorAll('input[data-path]'))
      input.checked = paths.has(input.dataset.path);
    syncFolders();
  };
  const addPath = (parent, path, title = path) => {
    const input = tick(parent, title, paths.has(path));
    input.dataset.path = path;
    on(input, 'change', () => {
      if (input.checked) paths.add(path);
      else paths.delete(path);
      selected();
    });
  };
  on(working, 'change', selected);
  const chooseCommits = button(
    'Choose commits',
    () => {
      const dialog = node('dialog', undefined, 'panel folder-picker commit-picker');
      attr(dialog, 'aria-label', 'Choose commits');
      const draft = new Set(commits);
      dialog.append(
        node('h2', 'Choose commits'),
        node('p', 'Check commits to include their changed paths.', 'muted'),
      );
      const filter = labeled(dialog, 'Search commits');
      filter.type = 'search';
      const rows = node('div', undefined, 'commit-list');
      const count = node('p', '', 'muted');
      const render = () => {
        rows.replaceChildren();
        const visible = recentCommits.filter((commit) =>
          `${commit.id} ${commit.subject}`.toLowerCase().includes(filter.value.toLowerCase()),
        );
        for (const commit of visible) {
          const input = tick(
            rows,
            `${commit.id.slice(0, 8)} ${commit.subject}`,
            draft.has(commit.id),
          );
          on(input, 'change', () => {
            if (input.checked) draft.add(commit.id);
            else draft.delete(commit.id);
            count.textContent = `${draft.size} selected`;
          });
        }
        if (!visible.length)
          rows.append(
            node(
              'p',
              recentCommits.length
                ? 'No matching commits.'
                : 'No commits. Choose files or working changes.',
              'muted',
            ),
          );
        count.textContent = `${draft.size} selected`;
      };
      on(filter, 'input', render);
      const close = () => {
        dialog.close();
        dialog.remove();
      };
      const actions = node('div', undefined, 'toolbar');
      actions.append(
        button(
          'Confirm commits',
          () => {
            commits.clear();
            for (const ref of draft) commits.add(ref);
            selected();
            close();
          },
          '',
        ),
        button('Cancel commit selection', close),
      );
      dialog.append(count, rows, actions);
      on(dialog, 'cancel', () => dialog.remove());
      document.body.append(dialog);
      dialog.showModal();
      render();
      filter.focus();
    },
    '',
  );
  chooseCommits.disabled = true;
  commitPanel.append(chooseCommits);
  const refs = profiles
    .filter((profile) => current.selectedProfiles.has(key(profile)))
    .map(reference);
  let inventory = [];
  const expanded = new Set(current.expandedFolders ?? []);
  const folderInputs = [];
  const syncFolders = () => {
    for (const [input, descendants] of folderInputs) {
      const count = descendants.filter((path) => paths.has(path)).length;
      input.checked = count === descendants.length;
      input.indeterminate = count > 0 && count < descendants.length;
    }
  };
  let fullTree = buildTree([]);
  const renderTree = () => {
    listing.replaceChildren();
    folderInputs.length = 0;
    const query = search.value.trim().toLowerCase();
    const visible = inventory.filter((path) => path.toLowerCase().includes(query));
    navigation.replaceChildren(
      node(
        'span',
        `${visible.length} files${query ? ' matching search' : ' in repository'}`,
        'muted',
      ),
    );
    const tree = query ? buildTree(visible) : fullTree;
    const descendantsOf = (directory) => fullTree.directories.get(directory).descendants;
    const draw = (branch, parent, prefix = '') => {
      for (const [name, child] of branch.children) {
        const directory = prefix + name;
        const group = node('div', undefined, 'tree-folder');
        const row = node('div', undefined, 'tree-row');
        const children = node('div', undefined, 'branches');
        const open = query || expanded.has(directory);
        children.hidden = !open;
        let mounted = false;
        const mount = () => {
          if (mounted) return;
          draw(child, children, directory + '/');
          mounted = true;
        };
        const expand = button(
          open ? '▾' : '▸',
          () => {
            children.hidden = !children.hidden;
            if (!children.hidden) mount();
            syncFolders();
            expand.textContent = children.hidden ? '▸' : '▾';
            attr(expand, 'aria-expanded', String(!children.hidden));
            attr(expand, 'aria-label', `${children.hidden ? 'Expand' : 'Collapse'} ${directory}`);
            if (children.hidden) expanded.delete(directory);
            else expanded.add(directory);
            current.expandedFolders = [...expanded];
          },
          'expander quiet',
        );
        attr(expand, 'aria-label', `${open ? 'Collapse' : 'Expand'} ${directory}`);
        attr(expand, 'aria-expanded', String(!!open));
        row.append(expand);
        const descendants = descendantsOf(directory);
        const input = tick(row, name + '/', false);
        attr(input, 'aria-label', `Select folder ${directory}`);
        on(input, 'change', () => {
          for (const path of descendants) {
            if (input.checked) paths.add(path);
            else paths.delete(path);
          }
          selected();
          syncFolders();
        });
        folderInputs.push([input, descendants]);
        row.append(node('span', String(descendants.length), 'muted'));
        if (open) mount();
        group.append(row, children);
        parent.append(group);
      }
      for (const path of branch.files) {
        const row = node('div', undefined, 'tree-row leaf');
        addPath(row, path, path.split('/').at(-1));
        attr(row.querySelector('input'), 'aria-label', path);
        parent.append(row);
      }
    };
    draw(tree, listing);
    if (!visible.length)
      listing.append(node('p', 'No matching files. Try another search.', 'muted'));
    syncFolders();
  };
  let inventoryRequest = 0;
  const reload = button('Refresh file tree', () => load());
  fileBar.append(reload, navigation);
  const requestQuery = () =>
    new URLSearchParams({ worktree: current.worktree, profiles: JSON.stringify(refs) });
  const loadContext = async () => {
    const result = await api(`repos/${current.repo.id}/selection-context?${requestQuery()}`);
    if (!active()) return;
    recentCommits = result.commits;
    chooseCommits.disabled = false;
    workingList.replaceChildren(node('p', `${result.workingCount} uncommitted files`, 'muted'));
    for (const path of result.working) addPath(workingList, path);
    if (!result.workingCount)
      workingList.append(node('p', 'This worktree has no uncommitted changes.', 'muted'));
    if (result.workingNext !== null)
      workingList.append(
        node('p', 'First 200 paths. Choose working changes above to select all.', 'muted'),
      );
  };
  const load = async () => {
    const request = ++inventoryRequest;
    loading.textContent = 'Reading repository file paths…';
    reload.disabled = true;
    respectIgnore.disabled = true;
    const query = requestQuery();
    query.set('respectGitIgnore', String(respectIgnore.checked));
    try {
      const result = await api(`repos/${current.repo.id}/inventory?${query}`);
      if (!active() || request !== inventoryRequest) return;
      const previous = new Set(inventory);
      inventory = result.files;
      const eligible = new Set(inventory);
      let removed = 0;
      for (const path of paths)
        if (previous.has(path) && !eligible.has(path)) {
          paths.delete(path);
          removed++;
        }
      if (removed)
        notice(`${removed} selected paths are no longer visible and were removed from selection.`);
      fullTree = buildTree(inventory);
      current.respectGitIgnore = respectIgnore.checked;
      loading.textContent = '';
      selected();
      renderTree();
    } catch (error) {
      if (active() && request === inventoryRequest)
        loading.textContent = `${error.message}. Refresh file tree to retry.`;
      throw error;
    } finally {
      if (active() && request === inventoryRequest) {
        reload.disabled = false;
        respectIgnore.disabled = false;
      }
    }
  };
  on(respectIgnore, 'change', () => void safely(() => load()));
  on(search, 'input', () => {
    current.fileQuery = search.value;
    renderTree();
  });
  body.append(browserPane, summary);
  selected();
  void safely(loadContext);
  await load();
  return () => {
    current.files = [...paths].join('\n');
    current.commits = [...commits].join('\n');
    current.working = working.checked;
  };
}

async function showWizard() {
  const form = $('wizard');
  const current = wizard;
  if (!current) return;
  const generation = ++wizardGeneration;
  form.hidden = false;
  $('profile-view').hidden = true;
  $('ws-view').hidden = true;
  $('resume').hidden = true;
  $('settings-view').hidden = true;
  setTab('workspaces-tab');
  form.replaceChildren();
  const title = {
    create: 'Create cloak workspace',
    refresh: 'Update cloak workspace',
    restore: 'Restore changes to source',
  }[current.intent];
  const steps =
    current.intent === 'restore'
      ? ['Choose target', 'Review & confirm']
      : current.intent === 'refresh'
        ? ['Select code', 'Profiles', 'Review & confirm']
        : ['Select code', 'Profiles', 'Destination', 'Review & confirm'];
  const progress = node('ol', undefined, 'steps');
  attr(progress, 'aria-label', 'Sync progress');
  for (const [index, label] of steps.entries()) {
    const item = node('li', label);
    if (index === current.step) attr(item, 'aria-current', 'step');
    if (index < current.step) item.className = 'complete';
    progress.append(item);
  }
  const head = node('div', undefined, 'wiz-head');
  head.append(node('h2', steps[current.step]), node('p', title, 'muted'), progress);
  const body = node('div', undefined, 'wizard-body');
  let collect = () => {};
  let next;
  const previewStep = current.intent === 'restore' ? 1 : current.intent === 'refresh' ? 2 : 3;
  const context = node('details', undefined, 'wt-pick');
  context.append(
    node(
      'summary',
      `${current.repo.name} · ${current.trees.find((tree) => tree.path === current.worktree)?.branch ?? 'Detached HEAD'} · Change worktree`,
    ),
  );
  const tree = choice(
    context,
    'Source worktree',
    current.worktree,
    current.trees.map((tree) => [tree.path, `${tree.branch ?? 'Detached HEAD'} · ${tree.path}`]),
  );
  on(tree, 'change', () =>
    safely(async () => {
      collect();
      if (current.preview) {
        await api(`sync/${current.preview.operationId}`, 'DELETE');
        current.preview = null;
      }
      current.worktree = tree.value;
      current.step = 0;
      current.directory = '';
      await showWizard();
    }),
  );
  if (current.step < previewStep) head.append(context);
  form.append(head, body);
  if (current.intent !== 'restore' && current.step === 1) {
    body.append(node('p', 'Choose profiles, or reuse saved profiles.'));
    const available = profiles.map((profile) => [
      profile,
      tick(
        body,
        `${profile.profile.name} (${profile.scope.kind})`,
        current.selectedProfiles.has(key(profile)),
      ),
    ]);
    collect = () => {
      current.selectedProfiles = new Set(
        available.filter(([, input]) => input.checked).map(([profile]) => key(profile)),
      );
    };
    body.append(
      button('Create or edit profiles', () => {
        collect();
        $('wizard').hidden = true;
        $('profiles-tab').click();
        $('resume').hidden = false;
      }),
    );
  } else if (current.step < previewStep && current.intent === 'restore') {
    const policy = choice(body, 'Conflict handling', current.policy, [
      ['block', 'Stop if conflicts exist'],
      ['skip', 'Skip conflicting files'],
      ['force', 'Force overwrites (requires confirmation)'],
    ]);
    collect = () => {
      current.policy = policy.value;
    };
  } else if (current.intent === 'create' && current.step === 2) {
    body.append(node('p', 'Create the anonymized repository in this folder.'));
    const root = labeled(body, 'Cloak workspaces folder', 'input', current.root);
    body.append(
      button('Browse workspace folder', () =>
        pickFolder(root.value, (path) => {
          root.value = path;
        }),
      ),
    );
    const commands = labeled(
      body,
      'Post-create commands (one per line)',
      'textarea',
      current.commands,
    );
    commands.rows = 3;
    body.append(
      node('p', 'Runs after creation. Failure stops commands; workspace stays.', 'muted'),
    );
    const save = tick(body, 'Save as workspace defaults', current.saveDefaults);
    const advanced = node('details');
    advanced.append(node('summary', 'Override workspace directory'));
    const destination = labeled(
      advanced,
      'Exact workspace directory (optional)',
      'input',
      current.destination,
    );
    advanced.append(
      button('Browse exact destination', () =>
        pickFolder(destination.value || root.value, (path) => {
          destination.value = path;
        }),
      ),
    );
    body.append(advanced);
    collect = () => {
      Object.assign(current, {
        root: root.value.trim(),
        commands: commands.value,
        saveDefaults: save.checked,
        destination: destination.value.trim(),
      });
    };
  } else if (current.step < previewStep) {
    collect = await renderSelection(body, current, generation);
    if (wizard !== current || generation !== wizardGeneration) return;
  } else {
    const preview = current.preview;
    body.append(node('p', `${preview.source.path} → ${preview.destination.path}`, 'path'));
    body.append(
      node(
        'p',
        `${preview.writes.length} files to write · ${preview.deletes.length} to delete · ${preview.replacements} replacements · ${preview.redactions} secrets redacted`,
      ),
    );
    for (const [title, values] of [
      ['Write', preview.writes],
      ['Delete', preview.deletes],
      ['Warning', preview.warnings],
      ['Conflict', preview.conflicts],
      ['Changed profile', preview.profileChanges],
      ['Post-create command', preview.postCreateCommands],
    ]) {
      if (!values.length) continue;
      const details = node('details');
      details.open = title !== 'Write';
      details.append(node('summary', `${title} · ${values.length}`));
      const list = node('ul');
      for (const value of values) list.append(node('li', value));
      details.append(list);
      body.append(details);
    }
    const deletions = preview.deletes.length ? tick(body, 'I confirm the listed deletions') : null;
    const changed = preview.profileChanges.length
      ? tick(body, 'I confirm the changed profiles')
      : null;
    const force = preview.forced ? tick(body, 'I confirm forced overwrites') : null;
    next = button(
      'Apply changes',
      async () => {
        if (current.running) return;
        if (
          (deletions && !deletions.checked) ||
          (changed && !changed.checked) ||
          (force && !force.checked)
        )
          throw new Error('Confirm the listed changes first');
        busy(true);
        notice('Applying changes…');
        current.running = true;
        next.disabled = true;
        back.disabled = true;
        cancel.disabled = true;
        const saved = {
          operationId: preview.operationId,
          repoId: current.repo.id,
          draft: { ...current, running: false, selectedProfiles: [...current.selectedProfiles] },
        };
        sessionStorage.setItem('cloak-operation', JSON.stringify(saved));
        try {
          const state = await api(`sync/${preview.operationId}/apply`, 'POST', {
            deletions: !!deletions?.checked,
            profiles: !!changed?.checked,
            force: !!force?.checked,
          });
          await monitorOperation(saved, state);
        } catch (error) {
          current.running = false;
          next.disabled = false;
          back.disabled = false;
          cancel.disabled = false;
          throw error;
        } finally {
          busy(false);
        }
      },
      '',
    );
    next.disabled = !preview.canApply;
    if (!preview.canApply)
      body.append(node('p', 'Go back, resolve conflicts, then preview again.', 'error'));
    body.append(
      node('p', `Preview expires ${new Date(preview.expiresAt).toLocaleTimeString()}`, 'muted'),
    );
  }
  const toolbar = node('div', undefined, 'toolbar wiz-foot');
  const back = button('Back', async () => {
    collect();
    if (current.preview) {
      await api(`sync/${current.preview.operationId}`, 'DELETE');
      current.preview = null;
    }
    current.step--;
    await showWizard();
  });
  back.disabled = current.step === 0;
  const cancel = button('Cancel', closeWizard);
  if (!next)
    next = button(
      current.step + 1 === previewStep ? 'Preview changes' : 'Continue',
      async () => {
        collect();
        if (
          current.intent === 'create' &&
          current.step === 0 &&
          !current.files.trim() &&
          !current.commits.trim() &&
          !current.working
        )
          throw new Error('Select files or changes to continue');
        if (current.intent === 'create' && current.step === 1 && !current.selectedProfiles.size)
          throw new Error('Select at least one profile');
        next.disabled = true;
        try {
          if (current.step + 1 === previewStep)
            current.preview = await api('sync/preview', 'POST', wizardInput(current));
          current.step++;
          await showWizard();
        } finally {
          next.disabled = false;
        }
      },
      '',
    );
  toolbar.append(back, next, cancel);
  form.append(toolbar);
  form.focus();
}
function wizardInput(current) {
  const request = { intent: current.intent, repoId: current.repo.id, worktree: current.worktree };
  if (current.workspace) request.workspaceId = current.workspace.id;
  if (current.intent === 'restore') request.policy = current.policy;
  else {
    const selected = profiles
      .filter((profile) => current.selectedProfiles.has(key(profile)))
      .map(reference);
    if (selected.length) request.profiles = selected;
    if (current.files.trim()) request.files = splitLines(current.files);
    if (current.commits.trim()) request.commits = splitLines(current.commits);
    if (current.working) request.working = true;
    if (current.intent === 'create') {
      if (current.destination) request.destination = current.destination;
      if (current.root) request.workspacesRoot = current.root;
      request.postCreateCommands = splitLines(current.commands);
      request.saveDefaults = current.saveDefaults;
    }
  }
  return request;
}
async function monitorOperation(saved, state) {
  busy(true);
  try {
    await finishOperation(saved, state);
  } finally {
    busy(false);
  }
}
async function finishOperation(saved, state) {
  while (!state || state.state === 'running') {
    notice('Syncing files…');
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    state = await api(`sync/${saved.operationId}`);
  }
  if (state.state === 'pending') {
    if (saved.draft) {
      wizard = { ...saved.draft, selectedProfiles: new Set(saved.draft.selectedProfiles) };
      await showWizard();
    }
    notice('Not started. Review the preview.');
    return;
  }
  sessionStorage.removeItem('cloak-operation');
  if (wizard) wizard.running = false;
  wizard = null;
  $('wizard').hidden = true;
  $('ws-view').hidden = false;
  repoId = saved.repoId;
  if (state.result) workspaceId = state.result.workspaceId;
  remember();
  await reload();
  if (state.result?.postCommands?.length) {
    const results = node('article', undefined, 'panel');
    results.append(node('h2', 'Post-create commands'));
    for (const command of state.result.postCommands)
      results.append(
        node(
          'p',
          `${command.status}: ${command.command}${command.exitCode === null ? ' (stopped)' : ` (exit ${command.exitCode})`}`,
        ),
      );
    $('ws-view').prepend(results);
  }
  notice(
    state.state === 'completed'
      ? `Sync complete · ${state.result.writes.length} files written · ${state.result.deletes.length} deleted`
      : `${state.code ?? state.state}: ${state.error ?? 'Create a new preview'}`,
    state.state !== 'completed',
  );
}
$('resume').onclick = () =>
  safely(async () => {
    if (!canLeaveEditor()) return;
    await loadProfiles();
    await showWizard();
  });

async function pickFolder(initial, select) {
  const dialog = node('dialog', undefined, 'panel folder-picker');
  dialog.append(node('h2', 'Choose a folder'));
  const path = labeled(dialog, 'Folder path', 'input', initial);
  const choices = node('div', undefined, 'choices');
  const navigation = node('div', undefined, 'toolbar');
  const load = async (folder, offset = 0) => {
    const result = await api(
      `folders?${new URLSearchParams({ path: folder, offset: String(offset) })}`,
    );
    path.value = result.path;
    if (!offset) choices.replaceChildren();
    navigation.replaceChildren(button('Parent directory', () => load(result.parent)));
    for (const entry of result.folders)
      choices.append(button(entry.name + '/', () => load(entry.path)));
    if (result.next !== null)
      navigation.append(button('More folders', () => load(result.path, result.next)));
  };
  dialog.append(
    button('Go to folder', () => load(path.value)),
    navigation,
    choices,
  );
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.append(
    button(
      'Use this folder',
      () => {
        select(path.value);
        close();
      },
      '',
    ),
    button('Cancel folder selection', close),
  );
  on(dialog, 'cancel', () => dialog.remove());
  await load(initial);
  document.body.append(dialog);
  dialog.showModal();
}
async function showSettings() {
  if (wizard?.running || !canLeaveEditor()) return;
  settings = await api('settings');
  $('wizard').hidden = true;
  $('ws-view').hidden = true;
  $('profile-view').hidden = true;
  $('resume').hidden = !wizard;
  setTab('settings-button');
  const view = $('settings-view');
  view.hidden = false;
  view.replaceChildren(node('h2', 'Workspace defaults'));
  const root = labeled(view, 'Default cloak workspaces folder', 'input', settings.workspacesRoot);
  view.append(
    button('Browse default folder', () =>
      pickFolder(root.value, (path) => {
        root.value = path;
      }),
    ),
  );
  const commands = labeled(
    view,
    'Default post-create commands (one per line)',
    'textarea',
    settings.postCreateCommands.join('\n'),
  );
  commands.rows = 4;
  view.append(node('p', 'Runs inside the workspace after creation.', 'muted'));
  view.append(
    button(
      'Save defaults',
      async () => {
        settings = await api('settings', 'PUT', {
          workspacesRoot: root.value.trim() || undefined,
          postCreateCommands: splitLines(commands.value),
        });
        if (wizard)
          Object.assign(wizard, {
            root: settings.workspacesRoot,
            commands: settings.postCreateCommands.join('\n'),
          });
        notice('Defaults saved');
      },
      '',
    ),
  );
}
$('settings-button').onclick = () => safely(showSettings);
