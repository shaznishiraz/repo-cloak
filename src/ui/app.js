/* global document, window, sessionStorage, history, location, URLSearchParams, fetch, crypto, structuredClone */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const incomingToken = params.get('token');
if (incomingToken) sessionStorage.setItem('cloak-token', incomingToken);
const token = sessionStorage.getItem('cloak-token');
params.delete('token');
history.replaceState(null, '', `/#${params}`);
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
  element.addEventListener('click', () => safely(action));
  return element;
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
  if (!repos.some((repo) => repo.id === repoId)) repoId = '';
  renderNavigation();
  await renderWorkspaces();
  await loadProfiles();
}
function renderNavigation() {
  $('repos').replaceChildren();
  const all = button('All repositories', () => selectRepo(''));
  all.classList.toggle('active', !repoId);
  $('repos').append(all);
  for (const repo of repos) {
    const item = button(`${repo.name} · ${repo.workspaces.length}`, () => selectRepo(repo.id));
    item.classList.toggle('active', repo.id === repoId);
    $('repos').append(item);
  }
  const selected = repos.find((repo) => repo.id === repoId);
  $('title').textContent = selected?.name ?? 'Your repositories';
  $('subtitle').textContent = selected?.path ?? 'Keep source code private. Keep work moving.';
}
async function selectRepo(id) {
  if (!canLeaveEditor()) return;
  repoId = id;
  workspaceId = null;
  checked.clear();
  remember();
  renderNavigation();
  await renderWorkspaces();
  await loadProfiles();
}
async function renderWorkspaces() {
  const view = $('workspace-view');
  view.replaceChildren();
  const selected = repoId ? repos.filter((repo) => repo.id === repoId) : repos;
  if (!selected.some((repo) => repo.workspaces.length)) {
    view.append(
      empty(
        'A private place to get work done',
        'Create a cloak workspace from your source repository. It will appear here with status and pull history.',
        'repo-cloak push --profile <name> --files src --to <directory>',
      ),
    );
    return;
  }
  for (const repo of selected) {
    for (const workspace of repo.workspaces) {
      const card = node('article', undefined, 'panel');
      const heading = node('div', undefined, 'card-heading');
      heading.append(
        node('h2', workspace.name),
        node('span', workspace.missing ? 'Missing on disk' : repo.name, 'pill'),
      );
      card.append(heading, node('p', workspace.path, 'path'));
      card.append(
        node(
          'p',
          `Last used ${new Date(workspace.lastUsedAt).toLocaleString()} · ${workspace.lastProfiles.join(', ') || 'No profiles'}`,
          'muted',
        ),
      );
      if (!workspace.missing) {
        const content = node('div');
        const show = button('View status & history', async () => {
          show.disabled = true;
          try {
            const detail = await api(`workspaces/${repo.id}/${encodeURIComponent(workspace.id)}`);
            workspaceId = workspace.id;
            remember();
            renderWorkspaceDetail(content, detail);
            show.textContent = 'Refresh status & history';
          } finally {
            show.disabled = false;
          }
        });
        card.append(show, content);
        if (workspaceId === workspace.id) {
          try {
            renderWorkspaceDetail(
              content,
              await api(`workspaces/${repo.id}/${encodeURIComponent(workspace.id)}`),
            );
          } catch (error) {
            content.append(node('p', error.message, 'muted'));
          }
        }
      }
      view.append(card);
    }
  }
}
function renderWorkspaceDetail(content, detail) {
  content.replaceChildren();
  const metrics = node('div', undefined, 'metrics');
  for (const kind of ['modified', 'added', 'deleted']) {
    const item = node('div');
    item.append(node('strong', String(detail.status[kind].length)), node('span', kind));
    metrics.append(item);
  }
  content.append(metrics);
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
  } else content.append(node('p', 'Workspace is unchanged since the last sync.', 'muted'));
  const history = node('details');
  history.append(node('summary', `Pull history · ${detail.history.length}`));
  const table = node('table', undefined, 'history');
  const head = node('thead');
  const row = node('tr');
  for (const title of ['When', 'Files', 'Commits', 'Working changes'])
    row.append(node('th', title));
  head.append(row);
  table.append(head);
  const body = node('tbody');
  for (const pull of detail.history) {
    const row = node('tr');
    for (const value of [
      new Date(pull.at).toLocaleString(),
      pull.selection.files,
      pull.selection.commits,
      pull.selection.working ? 'Included' : '—',
    ])
      row.append(node('td', String(value)));
    body.append(row);
  }
  table.append(body);
  history.append(table);
  content.append(history);
}
async function loadProfiles() {
  profiles = await api(`profiles${repoId ? `?repoId=${repoId}` : ''}`);
  $('profiles').replaceChildren();
  if (!profiles.length)
    $('profiles').append(
      empty(
        'Rules you can reuse',
        'Create a profile to replace proprietary names and redact secrets before sharing files.',
      ),
    );
  for (const profile of profiles) {
    const row = node('div', undefined, 'profile-row');
    const label = node('label');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked.has(key(profile));
    checkbox.addEventListener('change', () =>
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
    : { scope: scope(), profile: { kind: 'profile', schemaVersion: 1, name: '', rules: [] } };
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
  }
}
function setEditorMode(json) {
  if (
    !json &&
    (!editing.profile ||
      typeof editing.profile !== 'object' ||
      !Array.isArray(editing.profile.rules) ||
      editing.profile.rules.some(
        (rule) => !rule || !['literal', 'regex', 'secret'].includes(rule.type),
      ))
  )
    throw new Error(
      'The form needs a profile object with valid rule types. Keep editing JSON to correct it.',
    );
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
  input.addEventListener('input', () => change(input.value));
  label.append(input);
  parent.append(label);
}
function renderRule(rule, index) {
  const element = node('div', undefined, 'rule');
  const toolbar = node('div', undefined, 'toolbar');
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
$('workspaces-tab').addEventListener('click', () => {
  $('workspace-view').hidden = false;
  $('profile-view').hidden = true;
  $('workspaces-tab').classList.add('active');
  $('profiles-tab').classList.remove('active');
});
$('profiles-tab').addEventListener('click', () => {
  $('workspace-view').hidden = true;
  $('profile-view').hidden = false;
  $('profiles-tab').classList.add('active');
  $('workspaces-tab').classList.remove('active');
});
$('new-profile').addEventListener('click', () => safely(() => openEditor()));
$('close-editor').addEventListener('click', canLeaveEditor);
$('form-tab').addEventListener('click', () =>
  safely(() => {
    readForm();
    setEditorMode(false);
  }),
);
$('json-tab').addEventListener('click', () =>
  safely(() => {
    readForm();
    setEditorMode(true);
  }),
);
$('add-rule').addEventListener('click', () =>
  safely(() => {
    readForm();
    editing.profile.rules.push({
      id: `rule-${crypto.randomUUID().slice(0, 8)}`,
      type: 'literal',
      match: '',
      replace: '',
    });
    renderForm();
  }),
);
$('refresh').addEventListener('click', () => safely(reload));
$('check-profiles').addEventListener('click', () =>
  safely(async () => {
    const selected = profiles.filter((profile) => checked.has(key(profile))).map(reference);
    if (!selected.length) throw new Error('Select profiles to check together');
    const result = await api('profiles/check', 'POST', selected);
    notice(`${result.profiles} profiles are compatible · ${result.rules} active rules`);
  }),
);
$('editor').addEventListener('submit', (event) => {
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
    $('editor').hidden = true;
    await loadProfiles();
    notice(`Saved ${saved.profile.name}`);
  });
});
$('delete-profile').addEventListener('click', () =>
  safely(async () => {
    if (
      !window.confirm(`Delete profile ${editing.profile.name}? Workspaces keep their saved rules.`)
    )
      return;
    await api('profiles', 'DELETE', reference(editing));
    $('editor').hidden = true;
    await loadProfiles();
    notice('Profile deleted');
  }),
);
window.addEventListener('beforeunload', (event) => {
  if (!$('editor').hidden) event.preventDefault();
});
void safely(async () => {
  if (!token)
    throw new Error('Open this dashboard using repo-cloak ui to start an authenticated session.');
  schema = await api('schema/profile');
  await reload();
});
