/* global document, location, sessionStorage, fetch, window */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const entry = '/#token=browser-test-token';

test('workspace status, history and token survive reload', async ({ app, browser, screen }) => {
  await app.open(entry);
  await screen.getByRole('button', { name: 'View status & history' }).click();
  await expect(browser.locator('.ws-status')).toContainText('1 changed');
  await screen.getByText('Changed files', { exact: true }).click();
  await expect(browser.locator('#ws-view')).toContainText('modified: Northwind.txt');
  await expect(browser.locator('.history li')).toHaveCount(1);
  expect(await browser.evaluate(() => location.hash.includes('token'))).toBe(false);
  await browser.reload();
  await expect(browser.locator('.ws-status')).toContainText('1 changed');
});

test('profiles support form and JSON edits, validation, checks and deletion', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await screen.getByRole('button', { name: 'Profiles', exact: true }).click();
  await screen.getByRole('button', { name: 'New profile', exact: true }).click();
  await screen.getByLabel('Name', { exact: true }).fill('browser-profile');
  await screen.getByRole('button', { name: 'Add rule' }).click();
  await screen.getByLabel('Original name', { exact: true }).fill('Example');
  await screen.getByLabel('Anonymous name', { exact: true }).fill('Public');
  await screen.getByRole('button', { name: 'Save profile' }).click();
  await expect(browser.locator('#notice')).toContainText('Saved browser-profile');
  const row = browser.locator('.prof-row').filter({ hasText: 'browser-profile' });
  await row.getByRole('checkbox').check();
  await screen.getByRole('button', { name: 'Check selected' }).click();
  await expect(browser.locator('#notice')).toContainText('1 active rules');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await screen.getByRole('button', { name: 'JSON', exact: true }).click();
  const profile = {
    kind: 'profile',
    schemaVersion: 1,
    name: 'browser-profile',
    rules: [{ id: 'broken', type: 'regex', match: '[', replace: 'x' }],
    extensions: { preserved: true },
  };
  await screen.getByLabel('Profile JSON').fill(JSON.stringify(profile));
  await screen.getByRole('button', { name: 'Save profile' }).click();
  await expect(browser.locator('#notice')).toContainText('broken');
  await expect(browser.locator('#editor')).toBeVisible();
  profile.rules = [{ id: 'company', type: 'regex', match: 'Example', replace: 'Public' }];
  await screen.getByLabel('Profile JSON').fill(JSON.stringify(profile));
  await screen.getByRole('button', { name: 'Save profile' }).click();
  await expect(browser.locator('#editor')).toBeHidden();
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await screen.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(screen.getByLabel('Profile JSON')).toHaveValue(/"preserved": true/);
  await browser.onDialog('dismiss');
  await screen.getByRole('button', { name: 'Delete profile' }).click();
  await expect(row).toHaveCount(1);
  await browser.onDialog('accept');
  await screen.getByRole('button', { name: 'Delete profile' }).click();
  await expect(row).toHaveCount(0);
});

test('dashboard fits a narrow viewport', async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open(entry);
  await expect(screen.getByRole('heading', { name: 'sample-workspace' })).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
  await screen.getByRole('button', { name: 'Profiles', exact: true }).click();
  await screen.getByRole('button', { name: 'New profile', exact: true }).click();
  await screen.getByRole('button', { name: 'Add rule' }).click();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
});

test('a fresh tab without a token cannot load private data', async ({ app, browser }) => {
  await app.open('/');
  await expect(browser.locator('#notice')).toContainText('start an authenticated session');
  await expect(browser.locator('.prof-row')).toHaveCount(0);
  await expect(browser.locator('#ws-view article')).toHaveCount(0);
});

test('create wizard browses folders, retains choices, saves defaults and runs setup commands on mobile', async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open(entry);
  await screen
    .getByRole('button', { name: 'Create cloak workspace · sample-source', exact: true })
    .click();
  await expect(screen.getByLabel('Source worktree', { exact: true })).toBeHidden();
  await screen.getByRole('button', { name: 'Expand src', exact: true }).click();
  await browser
    .locator('#selection-files')
    .getByRole('checkbox', { name: 'src/Acme.ts', exact: true })
    .check();
  await expect(browser.locator('.sel-summary')).toContainText('src/Acme.ts');
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await screen.getByLabel('sample (global)', { exact: true }).check();
  await screen.getByRole('button', { name: 'Create or edit profiles' }).click();
  await screen.getByRole('button', { name: 'Return to wizard' }).click();
  await expect(screen.getByLabel('sample (global)', { exact: true })).toBeChecked();
  await screen.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(browser.locator('.sel-summary')).toContainText('src/Acme.ts');
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  const root = await screen.getByLabel('Cloak workspaces folder', { exact: true }).inputValue();
  await screen.getByLabel('Workspace name (optional)', { exact: true }).fill('browser-cloak');
  await screen.getByRole('button', { name: 'Browse workspace folder' }).click();
  await screen.getByLabel('Folder path', { exact: true }).fill(root);
  await screen.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await screen.getByLabel('Post-create commands (one per line)').fill('node -e "process.exit(0)"');
  await screen.getByRole('button', { name: 'Preview changes' }).click();
  await screen.getByText('Write · 1', { exact: true }).click();
  await expect(browser.locator('#wizard')).toContainText('src/Northwind.ts');
  await expect(browser.locator('#wizard')).toContainText('node -e "process.exit(0)"');
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
  await screen.getByRole('button', { name: 'Apply changes' }).click();
  await expect(browser.locator('#notice')).toContainText('Sync complete');
  await expect(browser.locator('#ws-view')).toContainText('completed: node -e');
  await screen.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(screen.getByLabel('Default cloak workspaces folder')).toHaveValue(root);
  await expect(screen.getByLabel('Default post-create commands (one per line)')).toHaveValue(
    'node -e "process.exit(0)"',
  );
  await screen.getByLabel('Default post-create commands (one per line)').fill('');
  await screen.getByRole('button', { name: 'Save defaults', exact: true }).click();
  await expect(browser.locator('#notice')).toContainText('Workspace defaults saved');
});

test('restore and refresh use the shared commands from a workspace card', async ({
  app,
  browser,
}) => {
  await app.open(entry);
  const card = browser.locator('#ws-view article').filter({ hasText: 'sample-workspace' });
  await card.getByRole('button', { name: 'Push to source', exact: true }).click();
  await expect(browser.locator('#notice')).toContainText('Sync complete · 1 files written');
  await expect(browser.locator('#wizard')).toBeHidden();
  await card.getByRole('button', { name: 'Pull from source', exact: true }).click();
  await expect(browser.locator('#notice')).toContainText('Sync complete · 0 files written');
  await expect(browser.locator('#wizard')).toBeHidden();
});

test('a new worktree opens setup even when another worktree has a workspace', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  const context = await browser.evaluate(async () => {
    const headers = { Authorization: 'Bearer ' + sessionStorage.getItem('cloak-token') };
    const repos = await (await fetch('/api/repos', { headers })).json();
    const trees = await (await fetch(`/api/repos/${repos[0].id}/worktrees`, { headers })).json();
    return {
      repoId: repos[0].id,
      path: trees.find((tree: { branch: string; path: string }) => tree.branch === 'secondary')
        .path,
    };
  });
  await app.open(
    `/#token=browser-test-token&repo=${context.repoId}&worktree=${encodeURIComponent(context.path)}`,
  );
  await expect(browser.locator('#wizard')).toBeVisible();
  await expect(screen.getByRole('tab', { name: 'Files & folders', exact: true })).toBeVisible();
  await expect(screen.getByLabel('Source worktree', { exact: true })).toBeHidden();
  await screen.getByText(/Change worktree/).click();
  await expect(screen.getByLabel('Source worktree', { exact: true })).toHaveValue(context.path);
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Cancelled setup should still be available on a later launch from that worktree.
  await browser.evaluate(() => {
    sessionStorage.setItem(
      'cloak-operation',
      JSON.stringify({ operationId: 'expired', repoId: 'expired' }),
    );
    return null;
  });
  await browser.reload();
  await expect(browser.locator('#wizard')).toBeVisible();
  expect(await browser.evaluate(() => sessionStorage.getItem('cloak-operation'))).toBe(null);
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('launching from a configured worktree or cloak workspace keeps the workspace view', async ({
  app,
  browser,
}) => {
  await app.open(entry);
  const context = await browser.evaluate(async () => {
    const headers = { Authorization: 'Bearer ' + sessionStorage.getItem('cloak-token') };
    const repos = await (await fetch('/api/repos', { headers })).json();
    const repo = repos.find((repo: { name: string }) => repo.name === 'sample-source');
    return { repoId: repo.id, path: repo.path, workspaceId: repo.workspaces[0].id };
  });
  const source = `/#token=browser-test-token&repo=${context.repoId}&worktree=${encodeURIComponent(context.path)}`;
  await app.open(source);
  await expect(browser.locator('#ws-view')).toContainText('sample-workspace');
  await expect(browser.locator('#wizard')).toBeHidden();
  await app.open(`${source}&workspace=${context.workspaceId}`);
  await expect(browser.locator('#ws-view')).toContainText('sample-workspace');
  await expect(browser.locator('#wizard')).toBeHidden();
});

test('reload recovers a completed apply after its original response is lost', async ({
  app,
  browser,
}) => {
  await app.open(entry);
  await browser.evaluate(async () => {
    const headers = {
      Authorization: 'Bearer ' + sessionStorage.getItem('cloak-token'),
      'Content-Type': 'application/json',
    };
    const repos = await (await fetch('/api/repos', { headers })).json();
    const repo = repos[0];
    const workspace = repo.workspaces.find(
      (workspace: { name: string; id: string }) => workspace.name === 'sample-workspace',
    );
    const preview = await (
      await fetch('/api/sync/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          intent: 'refresh',
          repoId: repo.id,
          workspaceId: workspace.id,
          worktree: repo.path,
        }),
      })
    ).json();
    await fetch(`/api/sync/${preview.operationId}/apply`, { method: 'POST', headers, body: '{}' });
    sessionStorage.setItem(
      'cloak-operation',
      JSON.stringify({ operationId: preview.operationId, repoId: repo.id }),
    );
    return null;
  });
  await browser.reload();
  await expect(browser.locator('#notice')).toContainText('Sync complete');
  expect(await browser.evaluate(() => sessionStorage.getItem('cloak-operation'))).toBe(null);
});

test('a first launch from a source repo opens folder selection without asking for repository or worktree', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  const repo = await browser.evaluate(async () => {
    const repos = await (
      await fetch('/api/repos', {
        headers: { Authorization: 'Bearer ' + sessionStorage.getItem('cloak-token') },
      })
    ).json();
    return repos.find(
      (repo: { name: string; id: string; path: string }) => repo.name === 'z-new-source',
    );
  });
  await app.open(
    `/#token=browser-test-token&repo=${repo.id}&worktree=${encodeURIComponent(repo.path)}`,
  );
  await expect(browser.locator('#wizard')).toBeVisible();
  await expect(screen.getByLabel('Source worktree', { exact: true })).toBeHidden();
  await expect(browser.locator('#selection-files .choices')).toContainText('hello.txt');
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('selection searches nested files live, preserves choices, and rejects empty setup', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await screen
    .getByRole('button', { name: 'Create cloak workspace · sample-source', exact: true })
    .click();
  await expect(screen.getByRole('heading', { name: 'Select code', exact: true })).toBeVisible();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(browser.locator('#notice')).toContainText('Select files');
  await screen.getByLabel('Search files across the repository').fill('acme.ts');
  await browser
    .locator('#selection-files')
    .getByRole('checkbox', { name: 'src/Acme.ts', exact: true })
    .check();
  await expect(browser.locator('.sel-summary')).toContainText('1 paths');
  await screen.getByLabel('Search files across the repository').fill('no-such-file');
  await expect(browser.locator('.choices').first()).toContainText('No matching files');
  await expect(browser.locator('.sel-summary')).toContainText('src/Acme.ts');
  await screen.getByRole('tab', { name: 'Uncommitted changes', exact: true }).click();
  await expect(screen.getByLabel('Include working changes', { exact: true })).toBeVisible();
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await screen.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(browser.locator('.sel-summary')).toContainText('src/Acme.ts');
  await screen.getByRole('button', { name: 'Remove path: src/Acme.ts', exact: true }).click();
  await expect(browser.locator('.sel-summary')).toContainText('0 paths');
});

test('commit picker searches, cancels drafts and confirms checkbox selections', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await screen
    .getByRole('button', { name: 'Create cloak workspace · sample-source', exact: true })
    .click();
  await screen.getByRole('tab', { name: 'Commits', exact: true }).click();
  await screen.getByRole('button', { name: 'Choose commits', exact: true }).click();
  const dialog = browser.locator('.commit-picker');
  await expect(dialog).toBeVisible();
  await screen.getByLabel('Search commits').fill('Initial fixture');
  await dialog.getByRole('checkbox').check();
  await screen.getByRole('button', { name: 'Cancel commit selection', exact: true }).click();
  await expect(browser.locator('.sel-summary')).toContainText('0 commits');
  await screen.getByRole('button', { name: 'Choose commits', exact: true }).click();
  await dialog.getByRole('checkbox').check();
  await screen.getByRole('button', { name: 'Confirm commits', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(browser.locator('.sel-summary')).toContainText('1 commits');
  await screen.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(screen.getByRole('heading', { name: 'Profiles', exact: true })).toBeVisible();
});

test('nested checklist expands inline and supports partial folder selections', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await screen
    .getByRole('button', { name: 'Create cloak workspace · sample-source', exact: true })
    .click();
  await expect(screen.getByLabel('Selected files and folders (one per line)')).toHaveCount(0);
  await expect(screen.getByLabel('Commit IDs or refs (one per line)')).toHaveCount(0);
  await screen.getByRole('button', { name: 'Expand src', exact: true }).click();
  await expect(
    browser.locator('#selection-files').getByRole('checkbox', { name: 'src/Acme.ts', exact: true }),
  ).toBeVisible();
  await screen.getByLabel('Select folder src', { exact: true }).check();
  await expect(browser.locator('.sel-summary')).toContainText('src/Acme.ts');
  await browser
    .locator('#selection-files')
    .getByRole('checkbox', { name: 'src/Acme.ts', exact: true })
    .uncheck();
  await expect(screen.getByLabel('Select folder src', { exact: true })).not.toBeChecked();
  expect(
    await browser.evaluate(
      () =>
        (document.querySelector('input[aria-label="Select folder src"]') as HTMLInputElement)
          .indeterminate,
    ),
  ).toBe(true);
  await screen.getByRole('button', { name: 'Expand src/nested', exact: true }).click();
  await expect(
    browser
      .locator('#selection-files')
      .getByRole('checkbox', { name: 'src/nested/extra.ts', exact: true }),
  ).toBeChecked();
  await screen.getByRole('button', { name: 'Collapse src', exact: true }).click();
  await screen.getByRole('button', { name: 'Expand src', exact: true }).click();
  await expect(
    browser.locator('#selection-files').getByRole('checkbox', { name: 'src/Acme.ts', exact: true }),
  ).not.toBeChecked();
});

test('theme persists after reload and commit dialog is centered in both layouts', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  const initial = await browser.evaluate(() => document.documentElement.dataset.theme ?? '');
  await screen
    .getByRole('button', {
      name: initial === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
      exact: true,
    })
    .click();
  const chosen = initial === 'dark' ? 'light' : 'dark';
  expect(await browser.evaluate(() => document.documentElement.dataset.theme ?? '')).toBe(chosen);
  await browser.reload();
  expect(await browser.evaluate(() => document.documentElement.dataset.theme ?? '')).toBe(chosen);
  await screen
    .getByRole('button', { name: 'Create cloak workspace · sample-source', exact: true })
    .click();
  await screen.getByRole('tab', { name: 'Commits', exact: true }).click();
  await screen.getByRole('button', { name: 'Choose commits', exact: true }).click();
  for (const width of [1280, 390]) {
    await browser.setViewport({ width, height: 844 });
    const centered = await browser.evaluate(() => {
      const dialog = document.querySelector('.commit-picker');
      if (!dialog) return false;
      const rect = dialog.getBoundingClientRect();
      return (
        Math.abs(rect.x + rect.width / 2 - window.innerWidth / 2) < 2 &&
        Math.abs(rect.y + rect.height / 2 - window.innerHeight / 2) < 2
      );
    });
    expect(centered).toBe(true);
  }
  await screen.getByRole('button', { name: 'Cancel commit selection', exact: true }).click();
});

test('Git-aware inventory loads once, respects ignore preference, and keeps traffic local', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await screen
    .getByRole('button', { name: 'Create cloak workspace · sample-source', exact: true })
    .click();
  const ignored = browser
    .locator('#selection-files')
    .getByRole('checkbox', { name: '.env', exact: true });
  await expect(screen.getByLabel('Respect Git ignore rules', { exact: true })).toBeChecked();
  await screen.getByRole('button', { name: 'Expand src', exact: true }).click();
  await expect(
    browser.locator('#selection-files').getByRole('checkbox', { name: 'src/Acme.ts', exact: true }),
  ).toBeVisible();
  await expect(ignored).toHaveCount(0);
  expect(
    await browser.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .filter((entry) => entry.name.includes('/inventory?')).length,
    ),
  ).toBe(1);
  await screen.getByLabel('Search files across the repository').fill('Acme');
  await screen.getByLabel('Search files across the repository').fill('');
  expect(
    await browser.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .filter((entry) => entry.name.includes('/inventory?')).length,
    ),
  ).toBe(1);
  await screen.getByLabel('Respect Git ignore rules', { exact: true }).uncheck();
  await ignored.check();
  await expect(browser.locator('.sel-summary')).toContainText('.env');
  await screen.getByLabel('Respect Git ignore rules', { exact: true }).check();
  await expect(ignored).toHaveCount(0);
  await expect(browser.locator('.sel-summary')).not.toContainText('.env');
  await screen.getByRole('button', { name: 'Refresh file tree', exact: true }).click();
  await expect(
    screen.getByRole('button', { name: 'Refresh file tree', exact: true }),
  ).toBeEnabled();
  expect(
    await browser.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .filter((entry) => entry.name.includes('/inventory?')).length,
    ),
  ).toBe(4);
  expect(
    await browser.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .every((entry) => new URL(entry.name).origin === location.origin),
    ),
  ).toBe(true);
});

test('minimal repository layout shows history and keeps paths inside details', async ({
  app,
  browser,
}) => {
  await app.open(entry);
  await expect(browser.locator('#new-ws')).toBeVisible();
  await expect(browser.locator('.hero-card')).toHaveCount(0);
  await expect(browser.locator('.overview-card')).toHaveCount(0);
  await expect(browser.locator('.repo-item[aria-current="page"]')).toHaveCount(1);
  await expect(browser.locator('#hero-stat')).toHaveCount(0);
  await expect(browser.locator('#activity-chart')).toHaveCount(0);
  const card = browser.locator('#ws-view article').filter({ hasText: 'sample-workspace' });
  await expect(card.getByText(/Last used/)).toContainText('Last used');
  await expect(card.getByText('Location', { exact: true })).toBeHidden();
  await expect(card.getByRole('button', { name: 'Pull from source', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Push to source', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'View status & history' }).click();
  await expect(card.getByText('Pull history · 1', { exact: true })).toBeVisible();
  await card.getByText('Workspace details', { exact: true }).click();
  await expect(card.getByText('Location', { exact: true })).toBeVisible();
  await expect(card.getByText(/[/\\]sample-workspace$/)).toBeVisible();
  await card.getByText('Workspace details', { exact: true }).click();
  await expect(card.getByText('Location', { exact: true })).toBeHidden();
  await browser.setViewport({ width: 390, height: 844 });
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
});

test('workspace deletion can be cancelled and confirmed', async ({ app, browser, screen }) => {
  await app.open(entry);
  await browser.evaluate(async () => {
    const headers = {
      Authorization: 'Bearer ' + sessionStorage.getItem('cloak-token'),
      'Content-Type': 'application/json',
    };
    const repos = await (await fetch('/api/repos', { headers })).json();
    const repo = repos.find((item: { name: string }) => item.name === 'sample-source');
    const profiles = await (await fetch('/api/profiles', { headers })).json();
    const profile = profiles.find(
      (item: { profile: { name: string } }) => item.profile.name === 'sample',
    );
    const preview = await (
      await fetch('/api/sync/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          intent: 'create',
          repoId: repo.id,
          worktree: repo.path,
          destination: repo.path + '/../delete-me',
          files: ['src/Acme.ts'],
          profiles: [{ id: profile.id, scope: profile.scope }],
        }),
      })
    ).json();
    const applied = await (
      await fetch(`/api/sync/${preview.operationId}/apply`, { method: 'POST', headers, body: '{}' })
    ).json();
    if (applied.error) throw new Error(applied.error);

    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await (await fetch(`/api/sync/${preview.operationId}`, { headers })).json();
      if (state.state !== 'running') break;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    if (state?.state !== 'completed') throw new Error(state?.error ?? 'Fixture creation timed out');
    return null;
  });
  await browser.reload();
  const card = browser.locator('#ws-view article').filter({ hasText: 'delete-me' });
  await browser.onDialog('dismiss');
  await card.getByRole('button', { name: 'Delete workspace delete-me', exact: true }).click();
  await expect(card).toHaveCount(1);
  await browser.onDialog('accept');
  await card.getByRole('button', { name: 'Delete workspace delete-me', exact: true }).click();
  await expect(screen.getByText('Workspace deleted', { exact: true })).toBeVisible();
  await expect(card).toHaveCount(0);
});

test('repositories can be removed from the sidebar and added back with their workspace links', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await browser.evaluate(async () => {
    const headers = { Authorization: 'Bearer ' + sessionStorage.getItem('cloak-token') };
    const repos = await (await fetch('/api/repos', { headers })).json();
    const repo = repos.find((repo: { name: string }) => repo.name === 'sample-source');
    sessionStorage.setItem('removed-source', repo.path);
    const remove = document.querySelector<HTMLButtonElement>(
      '[aria-label="Remove repository sample-source"]',
    );
    if (!remove) throw new Error('Repository remove action missing');
    remove.focus();
    return null;
  });
  await screen
    .getByRole('button', { name: 'Remove repository sample-source', exact: true })
    .click();
  await expect(
    screen.getByRole('button', { name: 'Remove repository sample-source', exact: true }),
  ).toHaveCount(0);
  await expect(browser.locator('#notice')).toContainText('Files are still on disk');
  await browser.reload();
  await expect(
    screen.getByRole('button', { name: 'Remove repository sample-source', exact: true }),
  ).toHaveCount(0);
  const restored = await browser.evaluate(async () => {
    const headers = {
      Authorization: 'Bearer ' + sessionStorage.getItem('cloak-token'),
      'Content-Type': 'application/json',
    };
    const response = await fetch('/api/repos', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: sessionStorage.getItem('removed-source') }),
    });
    if (!response.ok) throw new Error('Could not add source again');
    sessionStorage.removeItem('removed-source');
    const { repoId } = await response.json();
    const repos = await (await fetch('/api/repos', { headers })).json();
    return repos.find((repo: { id: string }) => repo.id === repoId);
  });
  expect(
    restored.workspaces.some(
      (workspace: { name: string }) => workspace.name === 'sample-workspace',
    ),
  ).toBe(true);
  await browser.reload();
  await browser.setViewport({ width: 390, height: 844 });
  await expect(
    screen.getByRole('button', { name: 'Remove repository sample-source', exact: true }),
  ).toBeVisible();
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
});

test('launch repositories join an existing group with combined and individual sync controls', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await browser.evaluate(async () => {
    const headers = {
      Authorization: 'Bearer ' + sessionStorage.getItem('cloak-token'),
      'Content-Type': 'application/json',
    };
    const repos = await (await fetch('/api/repos', { headers })).json();
    const frontend = repos.find((repo: { name: string }) => repo.name === 'z-new-source');
    const profiles = await (await fetch('/api/profiles', { headers })).json();
    const profile = profiles.find(
      (profile: { profile: { name: string } }) => profile.profile.name === 'sample',
    );
    const preview = await (
      await fetch('/api/sync/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          intent: 'create',
          repoId: frontend.id,
          worktree: frontend.path,
          destination: frontend.path + '/../group-frontend',
          files: ['hello.txt'],
          profiles: [{ id: profile.id, scope: profile.scope }],
        }),
      })
    ).json();
    await fetch(`/api/sync/${preview.operationId}/apply`, { method: 'POST', headers, body: '{}' });
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await (await fetch(`/api/sync/${preview.operationId}`, { headers })).json();
      if (state.state === 'completed') return null;
      if (state.state !== 'running') throw new Error(state.error ?? state.state);
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    throw new Error('Frontend fixture timed out');
  });
  await browser.reload();
  await screen.getByRole('button', { name: 'Add to group', exact: true }).click();
  await screen.getByLabel('Group name', { exact: true }).fill('Storefront');
  await browser.evaluate(async () => {
    const headers = { Authorization: 'Bearer ' + sessionStorage.getItem('cloak-token') };
    const repos = await (await fetch('/api/repos', { headers })).json();
    const backend = repos.find((repo: { name: string }) => repo.name === 'sample-source');
    const row = [...document.querySelectorAll('.group-member-editor')].find(
      (row) => row.querySelector('.check-line span')?.textContent === 'sample-source',
    );
    const select = row?.querySelectorAll('select')[1];
    if (!select) throw new Error('Backend worktree picker missing');
    select.value = backend.path;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const workspace = row?.querySelectorAll('select')[0];
    const option = [...(workspace?.options ?? [])].find(
      (option) => option.textContent === 'sample-workspace',
    );
    if (!workspace || !option) throw new Error('Backend workspace picker missing');
    workspace.value = option.value;
    workspace.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
  });
  await screen.getByRole('button', { name: 'Save group', exact: true }).click();
  await expect(browser.locator('#title')).toHaveText('Storefront');
  await expect(browser.locator('.ws-card')).toHaveCount(1);
  expect(
    await browser.evaluate(async () => {
      const headers = { Authorization: 'Bearer ' + sessionStorage.getItem('cloak-token') };
      const groups = await (await fetch('/api/groups', { headers })).json();
      return !!groups.find(
        (group: { name: string; folder?: string }) => group.name === 'Storefront',
      )?.folder;
    }),
  ).toBe(true);
  await browser.locator('#group-open summary').click();
  await expect(screen.getByRole('button', { name: 'Open in VS Code', exact: true })).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Open in Zed', exact: true })).toBeVisible();
  await browser.locator('#group-open summary').click();
  await browser.locator('.repo-item').filter({ hasText: 'z-new-source' }).click();
  await screen.getByRole('button', { name: 'Add to group', exact: true }).click();
  await browser.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('.group-editor > label select');
    const group = [...(select?.options ?? [])].find(
      (option) => option.textContent === 'Storefront',
    );
    if (!select || !group) throw new Error('Existing group missing');
    select.value = group.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
  });
  await screen.getByRole('button', { name: 'Save group', exact: true }).click();
  await expect(browser.locator('.ws-card')).toHaveCount(2);
  await expect(
    browser.locator('.ws-card').getByRole('button', { name: 'Pull from source', exact: true }),
  ).toHaveCount(2);
  await expect(
    browser.locator('.ws-card').getByRole('button', { name: 'Push to source', exact: true }),
  ).toHaveCount(2);
  await screen.getByRole('button', { name: 'Pull all', exact: true }).click();
  await expect(browser.locator('#notice')).toContainText('Group sync complete · 2 repositories');
  await screen.getByRole('button', { name: 'Push all', exact: true }).click();
  await expect(screen.getByRole('button', { name: 'Push all', exact: true })).toBeEnabled();
  await expect(browser.locator('#notice')).toContainText('Group sync complete · 2 repositories');
  await browser.reload();
  await expect(browser.locator('#title')).toHaveText('Storefront');
  for (const width of [1280, 390]) {
    await browser.setViewport({ width, height: 844 });
    await screen.getByRole('button', { name: 'Edit group', exact: true }).click();
    expect(
      await browser.evaluate(() => {
        const rect = document.querySelector('.group-editor')?.getBoundingClientRect();
        return (
          !!rect &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth &&
          document.documentElement.scrollWidth <= window.innerWidth
        );
      }),
    ).toBe(true);
    await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await screen.getByRole('button', { name: 'Edit group', exact: true }).click();
  await browser.onDialog('accept');
  await screen.getByRole('button', { name: 'Remove group', exact: true }).click();
  await expect(browser.locator('#notice')).toContainText('Group removed');
  await expect(browser.locator('.repo-group')).toHaveCount(0);
});

test('queued agent files require owner preview and expose scoped connection controls', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  const card = browser.locator('#ws-view article').filter({ hasText: 'sample-workspace' });
  await card.getByRole('button', { name: /Requests/ }).click();
  await expect(browser.locator('.agent-panel')).toBeVisible();
  await expect(browser.locator('.agent-panel')).toContainText('Need the class definition');
  await expect(browser.locator('.agent-request-file')).toContainText('src/Northwind.ts');
  await screen.getByRole('button', { name: 'Preview selected', exact: true }).click();
  await expect(
    screen.getByRole('heading', { name: 'Review requested files', exact: true }),
  ).toBeVisible();
  await screen.getByRole('button', { name: 'Approve & pull', exact: true }).click();
  await expect(browser.locator('#notice')).toContainText('Sync complete');
  await card.getByRole('button', { name: /Requests/ }).click();
  await expect(browser.locator('.agent-request-file')).toContainText('pulled');
  await screen.getByRole('button', { name: 'Connection', exact: true }).click();
  await expect(screen.getByRole('button', { name: 'Add to Codex', exact: true })).toBeVisible();
  await expect(screen.getByLabel('MCP configuration', { exact: true })).toHaveValue(
    /--workspace-id/,
  );
  await expect(screen.getByRole('button', { name: 'Policy', exact: true })).toHaveCount(0);
  await screen.getByRole('button', { name: 'Requests', exact: true }).click();
  await expect(browser.locator('.agent-panel')).toContainText(
    'Uses selected profile and repository exclusions.',
  );
  await browser.setViewport({ width: 390, height: 844 });
  expect(await browser.evaluate(() => document.documentElement.scrollWidth <= 390)).toBe(true);
  await screen.getByRole('button', { name: 'Close', exact: true }).click();
});
