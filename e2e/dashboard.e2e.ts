/* global document, location */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

const entry = '/#token=browser-test-token';

test('workspace status, history and token survive reload', async ({ app, browser, screen }) => {
  await app.open(entry);
  await screen.getByRole('button', { name: 'View status & history' }).click();
  await expect(browser.locator('.metrics')).toContainText('1 modified');
  await screen.getByText('Changed files', { exact: true }).click();
  await expect(browser.locator('#workspace-view')).toContainText('modified: Northwind.txt');
  await screen.getByText('Pull history · 1', { exact: true }).click();
  await expect(browser.locator('.history tbody tr')).toHaveCount(1);
  expect(await browser.evaluate(() => location.hash.includes('token'))).toBe(false);
  await browser.reload();
  await expect(browser.locator('.metrics')).toContainText('1 modified');
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
  const row = browser.locator('.profile-row').filter({ hasText: 'browser-profile' });
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
  await expect(browser.locator('.profile-row')).toHaveCount(0);
  await expect(browser.locator('#workspace-view article')).toHaveCount(0);
});
