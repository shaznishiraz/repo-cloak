/* global location */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Flows that cross package boundaries, which each package could only test against fakes.
const entry = '/#token=browser-test-token';

test('approving from home pulls the requested file through the admin route', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  const request = browser.locator('.ws-request');
  await expect(request).toContainText('src/Northwind.ts');
  await request.getByRole('button', { name: 'Approve & pull' }).click();
  await expect(browser.locator('.ws-request')).toHaveCount(0);
  await browser.evaluate(() => {
    location.hash = '#/history';
  });
  await expect(screen.getByRole('main')).toContainText('agent-approve');
});

test('a worktree without a cloak links to new cloak with that worktree chosen', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await browser.evaluate(() => {
    location.hash = '#/repos';
  });
  await screen
    .getByRole('button', { name: /sample-source/ })
    .first()
    .click()
    .catch(() => {});
  await browser
    .locator('.adm-tree', { hasText: 'secondary' })
    .getByText('Cloak', { exact: true })
    .click();
  expect(await browser.evaluate(() => location.hash)).toContain('#/new?repo=');
  await expect(browser.locator('main[aria-label="New cloak"]')).toContainText('secondary');
});

test('adding a repo browses real folders through the folders route', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await browser.evaluate(() => {
    location.hash = '#/repos';
  });
  await screen.getByRole('button', { name: '+ Add repo' }).click();
  // Start somewhere neutral so the listing never records this machine's home folder.
  await screen.getByLabel('Repository folder').fill('/usr');
  await screen.getByRole('button', { name: 'Browse' }).click();
  const folders = screen.getByRole('list', { name: 'Folders' });
  await expect(folders.getByRole('button', { name: 'bin', exact: true })).toBeVisible();
  await folders.getByRole('button', { name: 'bin', exact: true }).click();
  await screen.getByRole('button', { name: 'Use this folder' }).click();
  await expect(screen.getByLabel('Repository folder')).toHaveValue('/usr/bin');
});

test('first run saves a first profile through the profiles route', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await browser.evaluate(() => {
    location.hash = '#/setup';
  });
  await expect(browser.locator('main[aria-label="First run"]')).toBeVisible();
  const step = screen.getByRole('region', { name: /profile/i });
  await step.getByRole('button').first().click();
  await step.getByLabel('Profile name').fill('integration-profile');
  await step.getByRole('button', { name: /save|create/i }).click();
  await browser.evaluate(() => {
    location.hash = '#/profiles';
  });
  await expect(browser.locator('main[aria-label="Profiles"]')).toContainText('integration-profile');
});
