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

test('launch context selects the exact worktree when reusing the machine dashboard', async ({
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
  await screen
    .getByRole('button', { name: 'Create cloak workspace · sample-source', exact: true })
    .click();
  await expect(screen.getByLabel('Source worktree', { exact: true })).toBeHidden();
  await screen.getByText(/Change worktree/).click();
  await expect(screen.getByLabel('Source worktree', { exact: true })).toHaveValue(context.path);
  await screen.getByRole('button', { name: 'Cancel', exact: true }).click();
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
