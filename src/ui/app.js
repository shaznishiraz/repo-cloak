/* global document, window, sessionStorage, history, location, URLSearchParams, fetch, crypto, structuredClone, localStorage, matchMedia, TextEncoder, Blob, URL */
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
      group: 'M3 7V4h7l2 3h9v13H3zM7 11h10M7 15h6',
      folder: 'M3 7V4h7l2 3h9v13H3zM3 10h18',
      code: 'M8 6l-6 6 6 6m8-12 6 6-6 6M14 3l-4 18',
      request: 'M8 3h8v4H8zM8 5H5v16h14V5h-3M8 12h8M8 16h5',
      pull: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
      push: 'M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5',
      plus: 'M12 5v14M5 12h14',
      search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
      refresh: 'M20 7v5h-5M20 12a8 8 0 1 0-2 5',
      moon: 'M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10',
      sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
      history: 'M3 4v5h5M3 9a9 9 0 1 1 0 6M12 7v5l3 2',
      trash: 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6',
      sparkle:
        'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zm7 11 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z',
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
let groups = [];
let desktopApps = {};
let groupId = params.get('group') ?? '';
let groupResult;
const expandedGroups = new Set(groupId ? [groupId] : []);
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
  for (const button of document.querySelectorAll('.sync-btn, .repo-remove'))
    button.disabled = value;
  $('edit-group').disabled = value;
  $('join-group').disabled = value;
  $('new-group').disabled = value;
  const group = groups.find((group) => group.id === groupId);
  const missing = group?.members.some(
    (member) =>
      !repos.some(
        (repo) =>
          repo.id === member.repoId &&
          !repo.missing &&
          repo.workspaces.some(
            (workspace) => workspace.id === member.workspaceId && !workspace.missing,
          ),
      ),
  );
  $('pull-group').disabled = $('push-group').disabled = value || !!missing;
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
  if (groupId) hash.set('group', groupId);
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
  [repos, groups, settings, desktopApps] = await Promise.all([
    api('repos'),
    api('groups'),
    api('settings'),
    api('desktop'),
  ]);
  if (!groups.some((group) => group.id === groupId)) groupId = '';
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
  $('repository-count').title = `${repos.length} repositories`;
  const add = (name, id, count, path, parent = $('repos')) => {
    const row = node('div', undefined, 'repo-row');
    const item = button(undefined, () => selectRepo(id), 'repo-item');
    item.append(
      icon('repo'),
      node('span', name, 'repo-name'),
      node('span', String(count), 'repo-count'),
    );
    item.classList.toggle('active', !groupId && repoId === id);
    if (!groupId && repoId === id) attr(item, 'aria-current', 'page');
    if (path) item.title = path;
    const remove = button('', () => removeRepository(id), 'quiet trash repo-remove');
    remove.append(icon('trash'));
    remove.title = 'Remove repository from dashboard';
    attr(remove, 'aria-label', `Remove repository ${name}`);
    remove.disabled = syncing;
    row.append(item, remove);
    parent.append(row);
  };
  const grouped = new Set();
  for (const group of groups) {
    const section = node('div', undefined, 'repo-group');
    const heading = node('div', undefined, 'repo-group-heading');
    const expanded = expandedGroups.has(group.id);
    const toggle = button(
      expanded ? '⌄' : '›',
      () => {
        if (expandedGroups.has(group.id)) expandedGroups.delete(group.id);
        else expandedGroups.add(group.id);
        renderNavigation();
      },
      'quiet group-expand',
    );
    attr(toggle, 'aria-label', `Expand ${group.name}`);
    attr(toggle, 'aria-expanded', String(expanded));
    const item = button(undefined, () => selectGroup(group.id), 'repo-item');
    item.append(
      icon('group'),
      node('span', group.name, 'repo-name'),
      node('span', String(group.members.length), 'repo-count'),
    );
    item.title = group.name;
    item.classList.toggle('active', groupId === group.id);
    if (groupId === group.id) attr(item, 'aria-current', 'page');
    heading.append(toggle, item);
    const children = node('div', undefined, 'repo-group-members');
    children.hidden = !expanded;
    for (const member of group.members) {
      grouped.add(member.repoId);
      const repo = repos.find((repo) => repo.id === member.repoId);
      add(repo?.name ?? 'Unavailable repository', member.repoId, 1, repo?.path, children);
    }
    section.append(heading, children);
    $('repos').append(section);
  }
  if (groups.length && repos.some((repo) => !grouped.has(repo.id)))
    $('repos').append(node('span', 'Repositories', 'repo-section-label'));
  for (const repo of repos.filter((repo) => !grouped.has(repo.id)))
    add(repo.name, repo.id, repo.workspaces.length, repo.path);
  const group = groups.find((group) => group.id === groupId);
  const selected = group ? undefined : repos.find((repo) => repo.id === repoId);
  $('title').textContent = group?.name ?? selected?.name ?? 'Workspaces';
  $('title').title = selected ? `${selected.name} · ${selected.path}` : '';
  $('new-ws').hidden = !selected;
  $('join-group').hidden = !selected;
  $('group-controls').hidden = !group;
  $('group-open').replaceChildren();
  if (group)
    $('group-open').append(
      group.folder
        ? openFolderMenu(`groups/${group.id}/open`, 'Open group folder', group.folder)
        : button('Create group folder', () => openGroupEditor(group)),
    );
  const missing = group?.members.some(
    (member) =>
      !repos.some(
        (repo) =>
          repo.id === member.repoId &&
          !repo.missing &&
          repo.workspaces.some(
            (workspace) => workspace.id === member.workspaceId && !workspace.missing,
          ),
      ),
  );
  $('pull-group').disabled = $('push-group').disabled = syncing || !!missing;
  $('pull-group').title = $('push-group').title = missing
    ? 'Repair missing members with Edit group'
    : 'Sync every member using its saved workspace and worktree';
  attr($('new-ws'), 'aria-label', `Create cloak workspace · ${selected?.name ?? ''}`);
  $('new-ws').onclick = () => safely(() => startWizard(selected, null, 'create'));
  $('join-group').onclick = () => safely(() => openGroupEditor(null, selected));
  $('edit-group').onclick = () => safely(() => openGroupEditor(group));
  $('pull-group').onclick = () => safely(() => runGroupSync(group, 'refresh'));
  $('push-group').onclick = () => safely(() => runGroupSync(group, 'restore'));
  $('group-requests').onclick = () => safely(() => openGroupRequests(group));
}
on($('new-group'), 'click', () => safely(() => openGroupEditor()));
on($('add-repo'), 'click', () =>
  safely(async () => {
    if (wizard?.running || !canLeaveEditor()) return;
    await pickFolder(repos.find((repo) => repo.id === repoId)?.path ?? '', async (path) => {
      await safely(async () => {
        const result = await api('repos', 'POST', { path });
        if (wizard) await closeWizard();
        repoId = result.repoId;
        groupId = '';
        launchWorktree = result.worktree;
        workspaceId = null;
        remember();
        await reload();
        await selectRepo(repoId);
        await maybeStartSetup();
      });
    });
  }),
);
async function selectRepo(id) {
  if (!canLeaveEditor()) return;
  if (wizard && !(await closeWizard())) return;
  $('settings-view').hidden = true;
  $('profile-view').hidden = true;
  $('ws-view').hidden = false;
  repoId = id;
  groupId = '';
  workspaceId = null;
  checked.clear();
  remember();
  renderNavigation();
  await renderWorkspaces();
  await loadProfiles();
}
async function removeRepository(id) {
  if (syncing || wizard?.running || !canLeaveEditor()) return;
  busy(true);
  try {
    await api(`repos/${encodeURIComponent(id)}`, 'DELETE');
    if (wizard?.repo.id === id) await closeWizard();
    if (repos.find((repo) => repo.id === id)?.workspaces.some((item) => item.id === workspaceId))
      workspaceId = null;
    if (repoId === id) {
      repoId = '';
      workspaceId = null;
      launchWorktree = null;
      params.delete('worktree');
      checked.clear();
    }
    remember();
    await reload();
    notice('Repository removed. Files are still on disk.');
  } finally {
    busy(false);
  }
}
async function selectGroup(id) {
  if (syncing || !canLeaveEditor()) return;
  if (wizard && !(await closeWizard())) return;
  groupId = id;
  expandedGroups.add(id);
  workspaceId = null;
  $('settings-view').hidden = true;
  $('profile-view').hidden = true;
  $('ws-view').hidden = false;
  remember();
  renderNavigation();
  await renderWorkspaces();
}
function openFolderMenu(endpoint, title, path) {
  const menu = node('details', undefined, 'open-folder-menu');
  const summary = node('summary', undefined, 'quiet');
  summary.append(icon('folder'), node('span', 'Open'));
  attr(summary, 'aria-label', title);
  summary.title = path;
  const options = node('div', undefined, 'open-folder-options');
  for (const [target, app] of Object.entries(desktopApps)) {
    const action = button(app.label, async () => {
      action.disabled = true;
      try {
        await api(endpoint, 'POST', { target });
        menu.open = false;
        if (target === 'orca') notice('Folder added to Orca');
      } finally {
        action.disabled = !app.available;
      }
    });
    action.prepend(icon(target === 'folder' ? 'folder' : 'code'));
    action.disabled = !app.available;
    action.title = app.available
      ? path
      : (app.unavailableReason ?? 'Install this application or its command-line launcher first');
    options.append(action);
  }
  menu.append(summary, options);
  return menu;
}
function groupStateLabel(state) {
  return (
    {
      pending: 'Ready',
      running: 'Syncing…',
      completed: 'Synced',
      failed: 'Failed',
      unattempted: 'Not started',
    }[state] ?? state
  );
}

async function openGroupEditor(group = null, joiningRepo = null) {
  if (syncing || wizard?.running || !canLeaveEditor()) return;
  if (wizard && !(await closeWizard())) return;
  if (joiningRepo && !joiningRepo.workspaces.some((workspace) => !workspace.missing)) {
    notice('Create a cloak workspace first, then choose Add to group.');
    await startWizard(joiningRepo, null, 'create');
    return;
  }
  const dialog = node('dialog', undefined, 'panel folder-picker group-editor');
  attr(
    dialog,
    'aria-label',
    joiningRepo ? 'Add repository to group' : group ? 'Edit group' : 'New group',
  );
  const fields = node('div', undefined, 'group-fields');
  let saving = false;
  const error = node('p', '', 'dialog-error');
  attr(error, 'role', 'alert');
  const close = () => {
    if (saving) return;
    dialog.close();
    dialog.remove();
  };
  dialog.append(node('h2', joiningRepo ? 'Add to group' : group ? 'Edit group' : 'New group'));
  let target = group;
  let selector;
  if (joiningRepo) {
    selector = choice(dialog, 'Group', '', [
      ['', 'Create a new group'],
      ...groups.map((item) => [item.id, item.name]),
    ]);
    on(selector, 'change', () => {
      target = groups.find((item) => item.id === selector.value) ?? null;
      render();
    });
  }
  const trees = new Map(
    await Promise.all(
      repos.map(async (repo) => {
        try {
          return [repo.id, await api(`repos/${repo.id}/worktrees`)];
        } catch {
          return [repo.id, []];
        }
      }),
    ),
  );
  let name;
  let folderRoot;
  let rows = [];
  function render() {
    fields.replaceChildren();
    error.textContent = '';
    name = labeled(fields, 'Group name', 'input', target?.name ?? '');
    name.maxLength = 80;
    if (!target?.folder) {
      const location = node('div', undefined, 'group-folder-location');
      folderRoot = labeled(
        location,
        'Group folder location',
        'input',
        settings.workspacesRoot || '',
      );
      folderRoot.placeholder = 'Beside the selected cloak workspace';
      location.append(
        button('Browse…', () =>
          pickFolder(folderRoot.value, (path) => {
            folderRoot.value = path;
          }),
        ),
      );
      fields.append(location);
    } else {
      folderRoot = null;
      const location = node('p', target.folder, 'muted group-folder-path');
      location.title = target.folder;
      fields.append(location);
    }
    fields.append(
      node(
        'p',
        'Move selected cloak workspaces into one group folder. Files, history and agent connections stay together.',
        'muted',
      ),
    );
    rows = [];
    const available = [...repos];
    for (const member of target?.members ?? [])
      if (!available.some((repo) => repo.id === member.repoId))
        available.push({ id: member.repoId, name: 'Unavailable repository', workspaces: [] });
    for (const repo of available) {
      const member = target?.members.find((member) => member.repoId === repo.id);
      const row = node('div', undefined, 'group-member-editor');
      const check = tick(row, repo.name, !!member || joiningRepo?.id === repo.id);
      const options = repo.workspaces.filter((workspace) => !workspace.missing);
      const workspaces = [
        ['', 'Choose workspace'],
        ...options.map((workspace) => [
          workspace.id,
          workspace.groupId ? `${workspace.name} · grouped` : workspace.name,
        ]),
      ];
      if (member && !options.some((workspace) => workspace.id === member.workspaceId))
        workspaces.push([member.workspaceId, 'Unavailable workspace — choose another']);
      const workspace = choice(
        row,
        'Cloak workspace',
        member?.workspaceId ?? (options.length === 1 ? options[0].id : ''),
        workspaces,
      );
      const availableTrees = trees.get(repo.id) ?? [];
      const worktrees = [
        ['', 'Choose source worktree'],
        ...availableTrees.map((tree) => [
          tree.path,
          `${tree.branch ?? 'Detached HEAD'} · ${tree.path}`,
        ]),
      ];
      if (member && !availableTrees.some((tree) => tree.path === member.worktree))
        worktrees.push([member.worktree, 'Unavailable worktree — choose another']);
      const initialTree =
        member?.worktree ??
        (joiningRepo?.id === repo.id && availableTrees.some((tree) => tree.path === launchWorktree)
          ? launchWorktree
          : availableTrees.length === 1
            ? availableTrees[0].path
            : '');
      const worktree = choice(row, 'Source worktree', initialTree, worktrees);
      const update = () => {
        workspace.disabled = worktree.disabled = !check.checked;
      };
      on(check, 'change', update);
      update();
      if (!options.length)
        row.append(node('p', 'Create a workspace for this repository before adding it.', 'muted'));
      rows.push({ repoId: repo.id, check, workspace, worktree });
      fields.append(row);
    }
  }
  render();
  const actions = node('div', undefined, 'dialog-actions');
  const save = button(
    'Save group',
    async () => {
      save.disabled = true;
      try {
        const members = rows
          .filter((row) => row.check.checked)
          .map((row) => ({
            repoId: row.repoId,
            workspaceId: row.workspace.value,
            worktree: row.worktree.value,
          }));
        if (
          !name.value.trim() ||
          !members.length ||
          members.some((member) => !member.workspaceId || !member.worktree)
        )
          throw new Error(
            'Enter a name and choose a workspace and worktree for each selected repository.',
          );
        const input = { name: name.value.trim(), members, moveWorkspaces: true };
        if (folderRoot?.value.trim()) input.folderRoot = folderRoot.value.trim();
        notice('Moving cloak workspaces into the group folder…');
        saving = true;
        const saved = await api(
          target ? `groups/${target.id}` : 'groups',
          target ? 'PUT' : 'POST',
          target ? { group: input, revision: target.revision } : input,
        );
        groupId = saved.id;
        expandedGroups.add(saved.id);
        groupResult = null;
        remember();
        saving = false;
        close();
        await reload();
        notice('Group saved');
      } catch (cause) {
        error.textContent = cause.message;
      } finally {
        saving = false;
        save.disabled = false;
      }
    },
    '',
  );
  if (group && !joiningRepo) {
    const remove = button(
      'Remove group',
      async () => {
        if (
          !window.confirm(
            `Remove ${group.name} from groups? Its repositories and workspaces will stay intact.`,
          )
        )
          return;
        remove.disabled = true;
        try {
          await api(`groups/${group.id}`, 'DELETE', { revision: group.revision });
          groupId = '';
          groupResult = null;
          remember();
          close();
          await reload();
          notice('Group removed');
        } catch (cause) {
          error.textContent = cause.message;
        } finally {
          remove.disabled = false;
        }
      },
      'quiet danger',
    );
    actions.append(remove);
  }
  actions.append(button('Cancel', close), save);
  dialog.append(fields, error, actions);
  on(dialog, 'cancel', (event) => {
    if (saving) event.preventDefault();
    else dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  name.focus();
}

function reviewGroupBatch(batch) {
  return new Promise((resolve) => {
    const dialog = node('dialog', undefined, 'panel folder-picker group-review');
    const pulling = batch.intent === 'refresh';
    attr(dialog, 'aria-label', 'Review group sync');
    dialog.append(node('h2', pulling ? 'Review Pull all' : 'Review Push all'));
    const acknowledgements = [];
    const required = [];
    const apply = button(pulling ? 'Pull all' : 'Push all', () => finish(acknowledgements), '');
    const update = () => {
      apply.disabled =
        !batch.members.every((member) => member.summary.canApply) ||
        required.some((input) => !input.checked);
    };
    for (const member of batch.members) {
      const section = node('section', undefined, 'group-review-member');
      const summary = member.summary;
      section.append(
        node('h3', repos.find((repo) => repo.id === member.repoId)?.name ?? member.repoId),
      );
      section.append(
        node('p', `${summary.writes.length} writes · ${summary.deletes.length} deletions`, 'muted'),
      );
      for (const message of [...summary.conflicts, ...summary.warnings])
        section.append(node('p', message, 'muted'));
      if (!summary.canApply)
        section.append(
          node(
            'p',
            'Resolve this member with its individual Pull/Push action, then try the group again.',
            'dialog-error',
          ),
        );
      const ack = { repoId: member.repoId };
      acknowledgements.push(ack);
      const confirm = (key, label, paths) => {
        const details = node('details');
        details.append(node('summary', label), node('pre', paths.join('\n'), 'group-review-paths'));
        section.append(details);
        const input = tick(section, label);
        required.push(input);
        on(input, 'change', () => {
          ack[key] = input.checked;
          update();
        });
      };
      if (summary.deletes.length) confirm('deletions', 'Confirm listed deletions', summary.deletes);
      if (summary.profileChanges.length)
        confirm('profiles', 'Confirm changed profiles', summary.profileChanges);
      if (summary.forced) confirm('force', 'Confirm forced overwrites', summary.conflicts);
      dialog.append(section);
    }
    function finish(value) {
      dialog.close();
      dialog.remove();
      resolve(value);
    }
    const actions = node('div', undefined, 'dialog-actions');
    actions.append(
      button('Cancel', () => finish(null)),
      apply,
    );
    dialog.append(actions);
    on(dialog, 'cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    update();
    document.body.append(dialog);
    dialog.showModal();
  });
}

async function runGroupSync(group, intent, retryId) {
  if (!group || syncing || wizard?.running) return;
  busy(true);
  const completed = retryId
    ? (groupResult?.members ?? [])
        .filter((member) => member.state === 'completed')
        .map((member) => ({ repoId: member.repoId, state: 'completed' }))
    : [];
  if (!retryId) groupResult = null;
  notice('Preparing group sync…');
  let batch;
  let started = false;
  try {
    batch = retryId
      ? await api(`group-sync/${retryId}/retry`, 'POST', {})
      : await api(`groups/${group.id}/preview`, 'POST', { revision: group.revision, intent });
    let members = [];
    if (
      batch.members.some(
        (member) =>
          !member.summary.canApply ||
          member.summary.deletes.length ||
          member.summary.profileChanges.length ||
          member.summary.forced,
      )
    ) {
      members = await reviewGroupBatch(batch);
      if (!members) {
        notice('Group sync cancelled');
        return;
      }
    }
    const saved = { operationId: batch.operationId, groupId: group.id, completed };
    sessionStorage.setItem('cloak-group-operation', JSON.stringify(saved));
    started = true;
    try {
      const state = await api(`group-sync/${batch.operationId}/apply`, 'POST', { members });
      await monitorGroupOperation(saved, state);
    } catch (error) {
      // A lost response may still have started the server-owned queue.
      const observed = await api(`group-sync/${batch.operationId}`);
      if (observed.state === 'pending') {
        await api(`group-sync/${batch.operationId}`, 'DELETE');
        sessionStorage.removeItem('cloak-group-operation');
        throw error;
      }
      await monitorGroupOperation(saved, observed);
    }
  } finally {
    if (batch && !started) await api(`group-sync/${batch.operationId}`, 'DELETE');
    busy(false);
  }
}

async function monitorGroupOperation(saved, state) {
  busy(true);
  try {
    state ??= await api(`group-sync/${saved.operationId}`);
    if (state.state === 'pending') {
      const members = await reviewGroupBatch(state);
      if (!members) {
        await api(`group-sync/${saved.operationId}`, 'DELETE');
        sessionStorage.removeItem('cloak-group-operation');
        return;
      }
      state = await api(`group-sync/${saved.operationId}/apply`, 'POST', { members });
    }
    while (state.state === 'running') {
      const completed = state.members.filter((member) => member.state === 'completed').length;
      const active = state.members.find((member) => member.state === 'running');
      notice(
        `Syncing ${repos.find((repo) => repo.id === active?.repoId)?.name ?? 'group'} · ${completed}/${state.members.length} complete`,
      );
      for (const item of document.querySelectorAll('.group-member-status')) {
        const member = state.members.find((member) => member.repoId === item.dataset.repo);
        if (member) item.textContent = groupStateLabel(member.state);
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      state = await api(`group-sync/${saved.operationId}`);
    }
    sessionStorage.removeItem('cloak-group-operation');
    groupResult = { ...state, members: [...(saved.completed ?? []), ...state.members] };
    groupId = saved.groupId;
    remember();
    await reload();
    notice(
      state.state === 'completed'
        ? `Group sync complete · ${state.members.length} repositories`
        : (state.error ?? `Group sync ${state.state}`),
      state.state !== 'completed',
    );
  } finally {
    busy(false);
  }
}

async function renderWorkspaces() {
  const view = $('ws-view');
  view.replaceChildren();
  const group = groups.find((group) => group.id === groupId);
  const selected = group
    ? group.members.flatMap((member) => {
        const repo = repos.find((repo) => repo.id === member.repoId);
        const workspace = repo?.workspaces.find((workspace) => workspace.id === member.workspaceId);
        if (!repo || repo.missing || !workspace) {
          const missing = empty(
            repo?.name ?? 'Unavailable repository',
            'Workspace needs setup. Use Edit group to choose another workspace.',
          );
          view.append(missing);
          return [];
        }
        return [{ ...repo, workspaces: [workspace] }];
      })
    : repoId
      ? repos.filter((repo) => repo.id === repoId)
      : repos;
  if (groupResult?.groupId === groupId && groupResult.state === 'failed') {
    const retry = button(
      'Retry unfinished',
      () => runGroupSync(group, groupResult.intent, groupResult.operationId),
      'quiet',
    );
    const result = node('div', undefined, 'group-result');
    result.append(node('p', groupResult.error, 'muted'), retry);
    view.prepend(result);
  }
  if (!selected.some((repo) => repo.workspaces.length)) {
    if (group) return;
    view.append(
      empty(
        'Your cloak workspaces',
        'Create a workspace to start syncing.',
        repoId ? undefined : 'Add a source repository to begin.',
      ),
    );
    return;
  }
  for (const repo of selected) {
    for (const workspace of repo.workspaces) {
      const card = node('article', undefined, 'panel ws-card');
      const heading = node('div', undefined, 'card-head');
      const identity = node('div', undefined, 'ws-identity');
      const controls = node('div', undefined, 'ws-controls');
      const name = node('h2', workspace.name);
      name.title = workspace.name;
      identity.append(name);
      heading.append(identity, controls);
      if (workspace.missing) identity.append(node('span', 'Missing on disk', 'pill pill-muted'));
      else if (workspace.groupId && !group)
        identity.append(node('span', 'Grouped', 'pill pill-muted'));
      const meta = node('div', undefined, 'ws-meta');
      if (group || !repoId) {
        const source = node('span', repo.name, 'ws-source');
        source.title = repo.name;
        meta.append(source);
      }
      const member = group?.members.find((member) => member.repoId === repo.id);
      if (member) {
        const status = node(
          'span',
          workspace.missing ? 'Needs setup' : 'Ready',
          'group-member-status',
        );
        status.dataset.repo = repo.id;
        const result =
          groupResult?.groupId === groupId &&
          groupResult.members.find((item) => item.repoId === repo.id);
        if (result) {
          status.textContent = groupStateLabel(result.state);
          status.title = result.error ?? '';
        }
        meta.append(status);
      }
      const used = node(
        'time',
        `Last used ${new Date(workspace.lastUsedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
      );
      used.dateTime = workspace.lastUsedAt;
      used.title = new Date(workspace.lastUsedAt).toLocaleString();
      const badges = node('div', undefined, 'badges');
      attr(badges, 'aria-label', 'Applied profiles');
      for (const profile of workspace.lastProfiles) {
        const pill = node('span', profile);
        pill.title = profile;
        badges.append(pill);
      }
      meta.append(badges, used);
      card.append(heading, meta);
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
      controls.append(remove);
      view.append(card);

      if (!workspace.missing) {
        controls.insertBefore(
          openFolderMenu(
            `workspaces/${repo.id}/${encodeURIComponent(workspace.id)}/open`,
            `Open workspace ${workspace.name}`,
            workspace.path,
          ),
          remove,
        );
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
            () => quickSync(repo, workspace, intent, b, member?.worktree),
            `sync-btn action-block ${cls}`,
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
        const primary = node('div', undefined, 'workspace-actions');
        attr(primary, 'role', 'group');
        attr(primary, 'aria-label', 'Workspace actions');
        const exportButton = button(
          'Export diff',
          () => openExport(repo, workspace),
          'quiet action-block export-btn',
        );
        exportButton.prepend(icon('sparkle'));
        exportButton.title = 'Preview an anonymized commit diff';
        primary.append(
          syncBtn('pull', 'Pull from source', 'refresh', 'pull-btn'),
          syncBtn('push', 'Push to source', 'restore', 'push-btn'),
          exportButton,
        );
        const secondary = node('div', undefined, 'workspace-links');
        secondary.append(
          button(
            workspace.pendingRequests ? `Requests · ${workspace.pendingRequests}` : 'Requests',
            () => openAgentPanel(repo, workspace),
            'quiet ws-more',
          ),
          show,
        );
        actions.append(primary, secondary);
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

async function openGroupRequests(group) {
  if (!group || syncing) return;
  const dialog = node('dialog', undefined, 'panel folder-picker agent-panel');
  attr(dialog, 'aria-label', 'Group file requests');
  dialog.append(node('h2', `${group.name} · Requests`));
  for (const member of group.members) {
    const repo = repos.find((repo) => repo.id === member.repoId);
    const workspace = repo?.workspaces.find((workspace) => workspace.id === member.workspaceId);
    if (!repo || !workspace || workspace.missing) {
      dialog.append(node('p', 'A member workspace needs setup.', 'muted'));
      continue;
    }
    const row = node('div', undefined, 'group-result');
    const info = await api(`workspaces/${repo.id}/${encodeURIComponent(workspace.id)}/agent`);
    const count = info.requests.reduce(
      (sum, request) =>
        sum + request.files.filter((file) => ['pending', 'failed'].includes(file.state)).length,
      0,
    );
    row.append(
      node('span', `${repo.name} · ${count} pending files`),
      button('Open requests', () => {
        dialog.close();
        dialog.remove();
        return openAgentPanel(repo, workspace);
      }),
    );
    dialog.append(row);
  }
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.append(button('Close', close));
  on(dialog, 'cancel', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

async function openAgentPanel(repo, workspace) {
  if (syncing || wizard?.running) return;
  const endpoint = `workspaces/${repo.id}/${encodeURIComponent(workspace.id)}/agent`;
  const dialog = node('dialog', undefined, 'panel folder-picker agent-panel');
  attr(dialog, 'aria-label', 'Workspace file requests and agent connection');
  const head = node('div', undefined, 'toolbar');
  const tabs = node('div', undefined, 'tabs');
  const body = node('div', undefined, 'agent-panel-body');
  const message = node('p', '', 'dialog-error');
  attr(message, 'role', 'alert');
  let preview;
  let applying = false;
  const close = () => {
    if (applying) return;
    if (preview) void api(`sync/${preview.operationId}`, 'DELETE').catch(() => {});
    dialog.close();
    dialog.remove();
  };
  const closeButton = button('Close', close);
  head.append(node('h2', workspace.name), closeButton);
  const act = async (action) => {
    message.textContent = '';
    try {
      await action();
    } catch (error) {
      message.textContent = error.message;
    }
  };
  const buttons = [];
  for (const mode of ['Requests', 'Connection']) {
    const tab = button(mode, () => act(() => render(mode)), '');
    buttons.push([mode, tab]);
    tabs.append(tab);
  }
  async function render(mode = 'Requests') {
    if (applying) return;
    if (preview) {
      await api(`sync/${preview.operationId}`, 'DELETE');
      preview = null;
    }
    body.replaceChildren(node('p', 'Loading…', 'muted'));
    for (const [name, tab] of buttons) tab.classList.toggle('active', name === mode);
    const info = await api(endpoint);
    if (!dialog.isConnected) return;
    body.replaceChildren();
    if (mode === 'Requests') {
      const refresh = button('Refresh requests', () => act(() => render()));
      body.append(
        node(
          'p',
          'Agents can queue files. Only you can approve a pull. Uses selected profile and repository exclusions.',
          'muted',
        ),
        refresh,
      );
      if (!info.guidance)
        body.append(
          node(
            'p',
            'Open Connection to install agent guidance for this existing workspace.',
            'muted',
          ),
        );
      if (!info.requests.length) body.append(node('p', 'No requests yet.', 'agent-empty muted'));
      for (const request of [...info.requests].reverse()) {
        const section = node('section', undefined, 'agent-request');
        section.append(
          node('h3', `Request ${request.id.slice(0, 8)}`),
          node('p', request.reason, 'agent-reason'),
        );
        const checks = [];
        for (const file of request.files) {
          const row = node('div', undefined, 'agent-request-file');
          const pending = ['pending', 'failed'].includes(file.state);
          const input = tick(row, file.path, pending);
          input.disabled = !pending;
          input.parentElement.title = `${file.path}\nSource: ${file.original}`;
          row.append(node('small', `${file.state} · ${Math.ceil(file.size / 1024)} KB`, 'muted'));
          checks.push([file.path, input]);
          section.append(row);
        }
        const selected = () =>
          checks.filter(([, input]) => !input.disabled && input.checked).map(([path]) => path);
        const actions = node('div', undefined, 'actions');
        const inspect = button(
          'Preview selected',
          () =>
            act(async () => {
              const paths = selected();
              if (!paths.length) throw new Error('Select pending files first');
              inspect.disabled = true;
              try {
                preview = await api(`${endpoint}/requests/${request.id}/preview`, 'POST', {
                  paths,
                });
                body.replaceChildren(
                  node('h3', 'Review requested files'),
                  node('p', request.reason, 'agent-reason'),
                );
                for (const file of preview.selected)
                  body.append(
                    node('p', `${file.path} · ${Math.ceil(file.size / 1024)} KB`, 'path'),
                  );
                body.append(
                  node(
                    'p',
                    'Only these files will be pulled and anonymized. Existing workspace edits stay in place.',
                    'muted',
                  ),
                );
                const approve = button(
                  'Approve & pull',
                  () =>
                    act(async () => {
                      approve.disabled = true;
                      applying = true;
                      closeButton.disabled = true;
                      const saved = { operationId: preview.operationId, repoId: repo.id };
                      sessionStorage.setItem('cloak-operation', JSON.stringify(saved));
                      try {
                        let state;
                        try {
                          state = await api(
                            `${endpoint}/operations/${preview.operationId}/apply`,
                            'POST',
                            {},
                          );
                        } catch (error) {
                          state = await api(`sync/${preview.operationId}`);
                          if (state.state === 'pending') {
                            sessionStorage.removeItem('cloak-operation');
                            throw error;
                          }
                        }
                        preview = null;
                        applying = false;
                        close();
                        await monitorOperation(saved, state);
                      } finally {
                        applying = false;
                        closeButton.disabled = false;
                        approve.disabled = false;
                      }
                    }),
                  '',
                );
                const back = button('Back', () =>
                  act(async () => {
                    await api(`sync/${preview.operationId}`, 'DELETE');
                    preview = null;
                    await render();
                  }),
                );
                const footer = node('div', undefined, 'dialog-actions');
                footer.append(back, approve);
                body.append(footer);
              } finally {
                inspect.disabled = false;
              }
            }),
          '',
        );
        const reject = button('Reject selected', () =>
          act(async () => {
            const paths = selected();
            if (!paths.length) throw new Error('Select pending files first');
            reject.disabled = true;
            try {
              await api(`${endpoint}/requests/${request.id}/reject`, 'POST', { paths });
              await reload();
              await render();
            } finally {
              reject.disabled = false;
            }
          }),
        );
        if (request.files.some((file) => ['pending', 'failed'].includes(file.state))) {
          actions.append(inspect, reject);
          section.append(actions);
        }
        body.append(section);
      }
    } else if (mode === 'Connection') {
      body.append(
        node(
          'p',
          info.enabled
            ? 'Connected · agents can probe and queue files. Approval stays in this dashboard.'
            : 'Agent requests are disabled.',
          'muted',
        ),
      );
      if (!info.guidance) {
        body.append(
          button('Install guidance with Pull files', () => {
            close();
            return quickSync(repo, workspace, 'refresh');
          }),
        );
        return;
      }
      const connectionActions = node('div', undefined, 'actions');
      connectionActions.append(
        button(info.enabled ? 'Disable access' : 'Enable access', () =>
          act(async () => {
            await api(endpoint, 'PUT', { enabled: !info.enabled });
            await render('Connection');
          }),
        ),
      );
      if (info.enabled)
        connectionActions.append(
          button('Reconnect / rotate credential', () =>
            act(async () => {
              await api(endpoint, 'PUT', { enabled: true, rotate: true });
              await render('Connection');
            }),
          ),
        );
      body.append(connectionActions);
      const config = await api(`${endpoint}/mcp`);
      const provider = choice(body, 'Agent client', 'codex', [
        ['codex', 'Codex'],
        ['claude', 'Claude Code'],
        ['other', 'Other MCP client'],
      ]);
      const target = node('p', '', 'muted');
      const snippet = labeled(body, 'MCP configuration', 'textarea');
      snippet.readOnly = true;
      snippet.rows = 6;
      const add = button(
        'Add to Codex',
        () =>
          act(async () => {
            add.disabled = true;
            try {
              const result = await api(`${endpoint}/mcp/${provider.value}`, 'POST', {
                confirm: true,
              });
              target.textContent = result.message;
            } finally {
              add.disabled = !info.enabled;
            }
          }),
        '',
      );
      const update = () => {
        snippet.value = provider.value === 'codex' ? config.codex : config.claude;
        target.textContent =
          provider.value === 'codex'
            ? config.codexTarget
            : provider.value === 'claude'
              ? config.claudeTarget
              : 'Copy the stdio entry into your MCP client.';
        add.textContent = provider.value === 'codex' ? 'Add to Codex' : 'Add to Claude Code';
        add.hidden = provider.value === 'other';
        add.disabled = !info.enabled;
      };
      on(provider, 'change', update);
      update();
      const actions = node('div', undefined, 'actions');
      actions.append(
        button('Copy configuration', () =>
          act(async () => {
            await window.navigator.clipboard.writeText(snippet.value);
            target.textContent = 'Configuration copied';
          }),
        ),
        add,
      );
      body.append(
        target,
        actions,
        node(
          'p',
          'Existing entries stay intact. Reload the client after adding this connection. No credential is included in the configuration.',
          'muted',
        ),
      );
    }
  }
  dialog.append(head, tabs, body, message);
  on(dialog, 'cancel', (event) => {
    event.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
  await act(() => render());
}

async function openExport(repo, workspace) {
  const dialog = node('dialog', undefined, 'panel export-dialog');
  attr(dialog, 'aria-label', 'Export commit changes');
  const endpoint = `repos/${repo.id}/workspaces/${encodeURIComponent(workspace.id)}`;
  const close = button(
    '',
    () => {
      dialog.close();
      dialog.remove();
    },
    'quiet export-close',
  );
  close.textContent = '×';
  attr(close, 'aria-label', 'Close export');
  const title = node('div', undefined, 'export-heading');
  title.append(
    icon('sparkle'),
    node('h2', 'Export changes'),
    node('span', repo.name, 'muted'),
    close,
  );
  const layout = node('div', undefined, 'export-layout');
  const commitPane = node('section', undefined, 'export-pane');
  const filePane = node('section', undefined, 'export-pane export-files');
  const divider = node('div', undefined, 'export-divider');
  divider.tabIndex = 0;
  attr(divider, 'role', 'separator');
  attr(divider, 'aria-label', 'Resize changed files pane');
  attr(divider, 'aria-orientation', 'vertical');
  attr(divider, 'aria-valuemin', '200');
  attr(divider, 'aria-valuenow', '280');
  divider.title = 'Drag to resize · Arrow keys to adjust · Double-click to reset';
  function resizeFiles(width) {
    const max = Math.max(200, layout.clientWidth - 460);
    const value = Math.round(Math.max(200, Math.min(width, max)));
    layout.style.setProperty('--export-files-width', `${value}px`);
    attr(divider, 'aria-valuemax', String(max));
    attr(divider, 'aria-valuenow', String(value));
  }
  on(divider, 'pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    divider.focus();
    divider.setPointerCapture(event.pointerId);
  });
  on(divider, 'pointermove', (event) => {
    if (divider.hasPointerCapture(event.pointerId))
      resizeFiles(event.clientX - filePane.getBoundingClientRect().left);
  });
  on(divider, 'pointerup', (event) => {
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  });
  on(divider, 'keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    resizeFiles(
      event.key === 'Home' ? 280 : filePane.clientWidth + (event.key === 'ArrowRight' ? 24 : -24),
    );
  });
  on(divider, 'dblclick', () => resizeFiles(280));
  const diffPane = node('section', undefined, 'export-review');
  const search = node('input');
  search.type = 'search';
  search.placeholder = 'Find a commit…';
  attr(search, 'aria-label', 'Search commits');
  const commitList = node('div', undefined, 'export-scroll');
  const fileList = node('div', undefined, 'export-scroll');
  const fileTitle = node('strong', 'Changed files');
  const diffTitle = node('div', 'Select a file to review', 'export-pane-heading');
  const diff = node('div', undefined, 'export-review-content');
  const moreCommits = button('Load older commits', async () => {
    moreCommits.disabled = true;
    try {
      const page = await api(`${endpoint}/export-commits?offset=${commitOffset}`);
      commitOffset += page.length;
      for (const commit of page)
        if (!commits.some((item) => item.id === commit.id)) commits.push(commit);
      moreCommits.hidden = page.length < 20;
      drawCommits();
    } finally {
      moreCommits.disabled = false;
    }
  });
  const findRef = button('Find reference', async () => {
    const found = await api(
      `${endpoint}/export-commits?ref=${encodeURIComponent(search.value.trim())}`,
    );
    for (const commit of found) {
      if (!commits.some((item) => item.id === commit.id)) commits.push(commit);
      selectedCommits.add(commit.id);
    }
    search.value = '';
    drawCommits();
    await loadFiles();
  });
  findRef.title = 'Find a commit SHA, branch or tag';
  commitPane.append(
    node('div', 'Commits', 'export-pane-heading'),
    search,
    findRef,
    commitList,
    moreCommits,
  );
  filePane.append(node('div', undefined, 'export-pane-heading'), fileList, divider);
  filePane.firstChild.append(fileTitle);
  diffPane.append(diffTitle, diff);
  layout.append(commitPane, filePane, diffPane);
  const overrideLabel = node('label', undefined, 'export-toggle');
  const override = node('input');
  override.type = 'checkbox';
  overrideLabel.append(override, node('span', 'Include excluded files'));
  overrideLabel.title = 'Export only. Pull and Push exclusions remain enforced.';
  const status = node('span', 'Loading commits…', 'export-status muted');
  attr(status, 'role', 'status');
  const copy = button('Copy diff', copySelected, 'primary');
  copy.prepend(icon('sparkle'));
  copy.disabled = true;
  const footer = node('div', undefined, 'export-footer');
  footer.append(overrideLabel, status, copy);
  dialog.append(title, layout, footer);
  on(dialog, 'cancel', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  resizeFiles(280);
  let commits = [];
  let commitOffset = 0;
  const selectedCommits = new Set();
  const selectedFiles = new Set();
  const inventories = new Map();
  let groups = [];
  let active = '';
  let revision = 0;
  let previewRevision = 0;
  let selectionRevision = 0;
  let loading = false;
  let copying = false;
  const chronological = () => commits.filter((commit) => selectedCommits.has(commit.id)).reverse();
  function updateStatus() {
    const count = groups.filter(
      (file) => selectedFiles.has(file.path) && (!file.excluded || override.checked),
    ).length;
    status.textContent = loading
      ? 'Loading files…'
      : `${selectedCommits.size} commits · ${count} files`;
    copy.disabled = copying || loading || !count;
    override.disabled = loading;
  }
  function drawCommits() {
    commitList.replaceChildren();
    for (const commit of commits.filter((item) =>
      `${item.subject} ${item.id}`.toLowerCase().includes(search.value.toLowerCase()),
    )) {
      const row = node('label', undefined, 'export-commit-row');
      row.title = commit.subject;
      row.classList.toggle('selected', selectedCommits.has(commit.id));
      const check = node('input');
      check.type = 'checkbox';
      check.checked = selectedCommits.has(commit.id);
      on(check, 'change', () => {
        if (check.checked) selectedCommits.add(commit.id);
        else selectedCommits.delete(commit.id);
        drawCommits();
        void loadFiles();
      });
      const text = node('span', undefined, 'export-commit-text');
      text.append(
        node('span', commit.subject || '(no subject)'),
        node('code', commit.id.slice(0, 8)),
      );
      row.append(check, text);
      commitList.append(row);
    }
  }
  async function loadFiles() {
    const request = ++revision;
    ++selectionRevision;
    ++previewRevision;
    loading = true;
    updateStatus();
    diff.replaceChildren();
    diffTitle.textContent = 'Select a file to review';
    fileList.replaceChildren(node('p', 'Loading files…', 'muted'));
    try {
      const chosen = chronological();
      await Promise.all(
        chosen.map(async (commit) => {
          if (!inventories.has(commit.id)) {
            const result = await api(`${endpoint}/export-files`, 'POST', { commit: commit.id });
            inventories.set(commit.id, result.files);
          }
        }),
      );
      if (request !== revision || !dialog.isConnected) return;
      const combined = new Map();
      for (const commit of chosen) {
        for (const file of inventories.get(commit.id)) {
          let group = combined.get(file.path);
          if (!group) {
            group = {
              path: file.path,
              excluded: false,
              added: 0,
              removed: 0,
              entries: [],
            };
            combined.set(file.path, group);
          }
          group.excluded ||= file.excluded;
          group.added += file.added ?? 0;
          group.removed += file.removed ?? 0;
          group.entries.push({ commit, index: file.index });
        }
      }
      const oldPaths = new Set(groups.map((file) => file.path));
      groups = [...combined.values()].sort((a, b) => a.path.localeCompare(b.path));
      for (const file of groups) {
        if (!oldPaths.has(file.path) && (!file.excluded || override.checked))
          selectedFiles.add(file.path);
      }
      active = groups.some((file) => file.path === active)
        ? active
        : (groups.find((file) => !file.excluded || override.checked)?.path ?? '');
      loading = false;
      drawFiles();
      updateStatus();
      if (active) void showFile(active);
    } catch (error) {
      if (request !== revision) return;
      loading = false;
      override.disabled = false;
      groups = [];
      fileList.replaceChildren();
      status.textContent = error.message;
      copy.disabled = true;
    }
  }
  function stats(file) {
    const counts = node('span', undefined, 'export-stat');
    counts.append(
      node('span', `+${file.added}`, 'export-added'),
      node('span', `−${file.removed}`, 'export-removed'),
    );
    return counts;
  }
  function drawFiles() {
    fileTitle.textContent = `Changed files · ${groups.length}`;
    fileList.replaceChildren();
    for (const file of groups) {
      const row = node('div', undefined, 'export-file-row');
      row.classList.toggle('active', active === file.path);
      const check = node('input');
      check.type = 'checkbox';
      check.disabled = file.excluded && !override.checked;
      check.checked = !check.disabled && selectedFiles.has(file.path);
      attr(check, 'aria-label', `Include ${file.path}`);
      on(check, 'change', () => {
        if (check.checked) selectedFiles.add(file.path);
        else selectedFiles.delete(file.path);
        ++selectionRevision;
        updateStatus();
      });
      const name = button(
        undefined,
        () => {
          active = file.path;
          drawFiles();
          void showFile(file.path);
        },
        'export-file-name',
      );
      const parts = file.path.split('/');
      name.append(node('span', parts.pop(), 'export-file-basename'));
      if (parts.length) {
        const path = node('span', parts.join('/') + '/', 'export-file-folder');
        attr(path, 'aria-hidden', 'true');
        name.append(path);
      }
      attr(name, 'aria-label', file.path);
      name.title = file.path;
      row.append(check, name, stats(file));
      if (file.excluded) row.title = 'Repository exclusion · use the export toggle to include';
      fileList.append(row);
    }
    if (!groups.length)
      fileList.append(node('p', 'Select one or more commits.', 'export-empty muted'));
  }
  async function showFile(path) {
    const request = ++previewRevision;
    const file = groups.find((item) => item.path === path);
    diffTitle.replaceChildren(node('code', path));
    diff.replaceChildren();
    if (!file) return;
    if (file.excluded && !override.checked) {
      diff.append(
        node(
          'p',
          'Excluded file. Enable the toggle to preview it for this export.',
          'export-empty muted',
        ),
      );
      return;
    }
    diffTitle.append(stats(file));
    diff.append(node('p', 'Preparing anonymized diff…', 'export-empty muted'));
    try {
      const results = await Promise.all(
        file.entries.map(async ({ commit, index }) => ({
          commit,
          result: await api(`${endpoint}/export`, 'POST', {
            commit: commit.id,
            indexes: [index],
            includeExcluded: override.checked,
          }),
        })),
      );
      if (request !== previewRevision || !dialog.isConnected) return;
      diff.replaceChildren();
      for (const { commit, result } of results) {
        if (results.length > 1) diff.append(node('div', commit.subject, 'export-pane-heading'));
        for (const item of result.files) {
          const patch = node('pre', undefined, 'export-diff');
          for (const line of item.patch.split('\n')) {
            const type = /^(diff --git|\+\+\+ |--- )/.test(line)
              ? 'meta'
              : line.startsWith('@@')
                ? 'hunk'
                : line.startsWith('+')
                  ? 'add'
                  : line.startsWith('-')
                    ? 'del'
                    : 'context';
            patch.append(node('span', line || ' ', `diff-line diff-${type}`));
          }
          diff.append(patch);
        }
      }
    } catch (error) {
      if (request === previewRevision)
        diff.replaceChildren(node('p', error.message, 'export-empty error'));
    }
  }
  async function copySelected() {
    if (copy.disabled) return;
    copying = true;
    const request = selectionRevision;
    const includeExcluded = override.checked;
    const selection = groups.filter(
      (file) => selectedFiles.has(file.path) && (!file.excluded || includeExcluded),
    );
    const chosen = chronological();
    updateStatus();
    status.textContent = 'Preparing copy…';
    try {
      const patches = [];
      for (const commit of chosen) {
        const indexes = selection.flatMap((file) =>
          file.entries.filter((entry) => entry.commit.id === commit.id).map((entry) => entry.index),
        );
        for (let start = 0; start < indexes.length; start += 100) {
          const result = await api(`${endpoint}/export`, 'POST', {
            commit: commit.id,
            indexes: indexes.slice(start, start + 100),
            includeExcluded,
          });
          patches.push(result.patch);
        }
      }
      if (request !== selectionRevision || !dialog.isConnected)
        throw new Error('Selection changed. Copy again.');
      const patch = patches.filter(Boolean).join('\n');
      if (new TextEncoder().encode(patch).length > 1024 * 1024)
        throw new Error('Selected diff exceeds 1 MiB. Select fewer files.');
      await window.navigator.clipboard.writeText(patch);
      status.textContent = 'Anonymized diff copied';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      copying = false;
      const message = status.textContent;
      updateStatus();
      status.textContent = message;
    }
  }
  on(search, 'input', drawCommits);
  on(override, 'change', () => {
    ++selectionRevision;
    for (const file of groups) {
      if (file.excluded) {
        if (override.checked) selectedFiles.add(file.path);
        else selectedFiles.delete(file.path);
      }
    }
    drawFiles();
    updateStatus();
    if (active) void showFile(active);
  });
  try {
    commits = await api(`${endpoint}/export-commits`);
    commitOffset = commits.length;
    moreCommits.hidden = commits.length < 20;
    if (commits[0]) selectedCommits.add(commits[0].id);
    drawCommits();
    await loadFiles();
  } catch (error) {
    status.textContent = error.message;
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
    const name = node('span', profile.profile.name);
    name.title = profile.profile.name;
    const summary = node('span');
    summary.append(
      name,
      node(
        'small',
        `${profile.scope.kind === 'global' ? 'All repositories' : 'This repository'} · ${profile.profile.rules.length} rules`,
      ),
    );
    label.append(checkbox, summary);
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
  $('editor-title').title = $('editor-title').textContent;
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
  document.querySelector('.editor-body').scrollTop = 0;
  $('profile-name').focus();
}
on($('import-profile'), 'click', () => $('import-profile-file').click());
on($('import-profile-file'), 'change', () =>
  safely(async () => {
    const input = $('import-profile-file');
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) throw new Error('Profile exceeds 1 MiB');
    const profile = await api(
      'profiles/validate',
      'POST',
      JSON.parse((await file.text()).replace(/^\uFEFF/, '')),
    );
    if (!canLeaveEditor()) return;
    openEditor();
    editing.profile = profile;
    setEditorMode(false);
    notice('Review the imported profile, choose its scope, then save.');
  }),
);
on($('export-profile'), 'click', () =>
  safely(async () => {
    readForm();
    const profile = await api('profiles/validate', 'POST', editing.profile);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(profile, null, 2) + '\n'], { type: 'application/json' }),
    );
    const link = node('a');
    link.href = url;
    link.download = `${profile.name.replace(/[^a-z0-9_-]/gi, '_') || 'profile'}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }),
);
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
  const toolbar = node('div', undefined, 'toolbar');
  const remove = button(
    '',
    () => {
      readForm();
      editing.profile.rules.splice(index, 1);
      renderForm();
    },
    'quiet trash',
  );
  remove.title = `Remove rule ${index + 1}`;
  remove.setAttribute('aria-label', remove.title);
  remove.append(icon('trash'));
  toolbar.append(node('h3', `Rule ${index + 1}`), remove);
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
    groupId = params.get('group') ?? '';
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
  if (!token) throw new Error('Run repo-cloak to open an authenticated dashboard.');
  schema = await api('schema/profile');
  await reload();
  const savedGroup = sessionStorage.getItem('cloak-group-operation');
  if (savedGroup) {
    try {
      await monitorGroupOperation(JSON.parse(savedGroup));
    } catch (error) {
      sessionStorage.removeItem('cloak-group-operation');
      notice(`${error.message}. Refresh status before starting another group sync.`, true);
    }
  }
  const saved = sessionStorage.getItem('cloak-operation');
  if (saved) {
    try {
      await monitorOperation(JSON.parse(saved));
    } catch (error) {
      sessionStorage.removeItem('cloak-operation');
      notice(`${error.message}. Refresh status before retrying.`, true);
    }
  }
  await maybeStartSetup();
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
  if (
    repo &&
    launchWorktree &&
    !workspaceId &&
    !groupId &&
    !repo.workspaces.some(
      (workspace) => !workspace.missing && workspace.worktree === launchWorktree,
    )
  )
    await startWizard(repo, null, 'create');
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
async function quickSync(repo, workspace, intent, trigger, selectedWorktree) {
  if (wizard?.running || syncing) return;
  busy(true);
  groupResult = null;
  trigger?.classList.add('syncing');
  notice(intent === 'refresh' ? 'Pulling files…' : 'Pushing changes…');
  try {
    const worktree = selectedWorktree ?? (await loadSyncContext(repo, workspace)).worktree;
    const preview = await api('sync/preview', 'POST', {
      intent,
      repoId: repo.id,
      workspaceId: workspace.id,
      worktree,
    });
    if (
      !preview.canApply ||
      preview.deletes.length ||
      preview.profileChanges.length ||
      preview.conflicts.length ||
      preview.forced
    ) {
      await api(`sync/${preview.operationId}`, 'DELETE');
      await startWizard(repo, workspace, intent, worktree);
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
async function startWizard(repo, workspace, intent, selectedWorktree) {
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
    worktree: selectedWorktree ?? worktree,
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
    name: '',
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
      let commitOffset = current.commitOffset ?? recentCommits.length;
      const historyQuery = () => new URLSearchParams({ worktree: current.worktree });
      const more = button('Load older commits', async () => {
        more.disabled = true;
        try {
          const query = historyQuery();
          query.set('offset', String(commitOffset));
          const page = await api(`repos/${current.repo.id}/commits?${query}`);
          commitOffset += page.length;
          current.commitOffset = commitOffset;
          for (const commit of page)
            if (!recentCommits.some((item) => item.id === commit.id)) recentCommits.push(commit);
          more.hidden = page.length < 20;
          render();
        } finally {
          more.disabled = false;
        }
      });
      const find = button('Find SHA, branch or tag', async () => {
        const query = historyQuery();
        query.set('ref', filter.value.trim());
        const found = await api(`repos/${current.repo.id}/commits?${query}`);
        for (const commit of found) {
          if (!recentCommits.some((item) => item.id === commit.id)) recentCommits.push(commit);
          draft.add(commit.id);
        }
        filter.value = '';
        render();
      });
      const close = () => {
        dialog.close();
        dialog.remove();
      };
      const actions = node('div', undefined, 'dialog-actions');
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
      dialog.append(find, count, rows, more, actions);
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
    current.commitOffset = recentCommits.length;
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
    const advanced = node('details');
    advanced.append(node('summary', 'Restore into a new branch'));
    const branch = labeled(advanced, 'New branch (optional)', 'input', current.newWorktree ?? '');
    const base = labeled(
      advanced,
      'Base commit or reference (optional)',
      'input',
      current.base ?? '',
    );
    const path = labeled(
      advanced,
      'New worktree directory (optional)',
      'input',
      current.restorePath ?? '',
    );
    body.append(advanced);
    collect = () => {
      current.policy = policy.value;
      current.newWorktree = branch.value.trim();
      current.base = base.value.trim();
      current.restorePath = path.value.trim();
      if (!current.newWorktree && (current.base || current.restorePath))
        throw new Error('Enter a new branch name to use a base or destination override');
    };
  } else if (current.intent === 'create' && current.step === 2) {
    body.append(node('p', 'Create the anonymized repository in this folder.'));
    const workspaceName = labeled(body, 'Workspace name (optional)', 'input', current.name ?? '');
    workspaceName.placeholder = 'Auto-generated · use a neutral name';
    workspaceName.maxLength = 80;
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
        name: workspaceName.value.trim(),
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
  if (current.intent === 'restore') {
    request.policy = current.policy;
    if (current.newWorktree) {
      delete request.worktree;
      request.newWorktree = current.newWorktree;
      if (current.base) request.base = current.base;
      if (current.restorePath) request.path = current.restorePath;
    }
  } else {
    const selected = profiles
      .filter((profile) => current.selectedProfiles.has(key(profile)))
      .map(reference);
    if (selected.length) request.profiles = selected;
    if (current.files.trim()) request.files = splitLines(current.files);
    if (current.commits.trim()) request.commits = splitLines(current.commits);
    if (current.working) request.working = true;
    if (current.intent === 'create') {
      if (current.name) request.name = current.name;
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
  const actions = node('div', undefined, 'dialog-actions');
  actions.append(
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
  dialog.append(actions);
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
  const heading = node('div', undefined, 'prof-head');
  heading.append(
    node('h2', 'Settings'),
    node('p', 'Local defaults and repository exclusions.', 'muted'),
  );
  const content = node('div', undefined, 'settings-body');
  view.replaceChildren(heading, content);
  if (repoId) {
    const exclusionSection = node('section', undefined, 'settings-section');
    exclusionSection.append(
      node('h2', 'Repository-wide file exclusions'),
      node(
        'p',
        'Excluded paths stay out of the file picker and cannot be pulled or pushed, regardless of profile.',
        'muted',
      ),
    );
    const exclusionField = labeled(exclusionSection, 'Patterns (one per line)', 'textarea');
    exclusionField.rows = 4;
    exclusionField.spellcheck = false;
    exclusionField.placeholder = '*.env\nsecrets/\n/private-config.json';
    try {
      const saved = await api(`repos/${repoId}/exclusions`);
      exclusionField.value = saved.patterns.join('\n');
    } catch (error) {
      exclusionSection.append(node('p', error.message, 'error'));
    }
    exclusionSection.append(
      node('p', 'Stored encrypted on this device for this repository.', 'muted'),
      button(
        'Save exclusions',
        async () => {
          const saved = await api(`repos/${repoId}/exclusions`, 'PUT', {
            patterns: splitLines(exclusionField.value),
          });
          exclusionField.value = saved.patterns.join('\n');
          notice('Repository exclusions saved');
        },
        '',
      ),
    );
    content.append(exclusionSection);
  }
  const defaults = node('section', undefined, 'settings-section');
  defaults.append(node('h2', 'Workspace defaults'));
  const folder = node('div', undefined, 'folder-field');
  const root = labeled(folder, 'Default cloak workspaces folder', 'input', settings.workspacesRoot);
  const browse = button('Browse', () =>
    pickFolder(root.value, (path) => {
      root.value = path;
    }),
  );
  browse.setAttribute('aria-label', 'Browse default folder');
  browse.prepend(icon('folder'));
  folder.append(browse);
  defaults.append(folder);
  const commands = labeled(
    defaults,
    'Default post-create commands (one per line)',
    'textarea',
    settings.postCreateCommands.join('\n'),
  );
  commands.rows = 4;
  defaults.append(node('p', 'Runs inside the workspace after creation.', 'muted'));
  defaults.append(
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
        notice('Workspace defaults saved');
      },
      '',
    ),
  );
  content.append(defaults);
}
$('settings-button').onclick = () => safely(showSettings);
