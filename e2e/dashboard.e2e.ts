/* global location, sessionStorage, document, window */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The fixture in server.ts registers two sources, one workspace and one agent request.
const entry = '/#token=browser-test-token';

test('shell loads real counts and moves the token out of the address bar', async ({
  app,
  browser,
}) => {
  await app.open(entry);
  await expect(browser.locator('.store-chip')).toContainText('Store sealed');
  await expect(browser.locator('.rail')).toContainText('Workspaces');
  await expect(browser.locator('.rail-foot')).toContainText('1 workspace');
  expect(await browser.evaluate(() => location.hash.includes('token'))).toBe(false);
  expect(await browser.evaluate(() => sessionStorage.length)).toBeGreaterThan(0);
  await browser.reload();
  await expect(browser.locator('.store-chip')).toContainText('Store sealed');
});

test('every route renders its screen', async ({ app, browser }) => {
  await app.open(entry);
  for (const [hash, title] of [
    ['#/', 'Workspaces'],
    ['#/new', 'New cloak'],
    ['#/setup', 'First run'],
    ['#/repos', 'Known repos'],
    ['#/requests', 'Agent requests'],
    ['#/profiles', 'Profiles'],
    ['#/history', 'History'],
    ['#/settings', 'Settings'],
    ['#/ws/example/push', 'Push review'],
    ['#/groups/example', 'Group'],
  ]) {
    await browser.evaluate((next) => {
      location.hash = next;
    }, hash);
    await expect(browser.locator(`main[aria-label^="${title}"]`)).toBeVisible();
  }
});

test('the palette opens, navigates and closes', async ({ app, browser, screen }) => {
  await app.open(entry);
  await expect(browser.locator('.store-chip')).toBeVisible();
  await browser.locator('.search').click();
  const input = screen.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('Known repos');
  await input.press('Enter');
  await expect(browser.locator('main[aria-label="Known repos"]')).toBeVisible();
  expect(await browser.evaluate(() => location.hash)).toBe('#/repos');
  await expect(input).toBeHidden();
});

test('the phone layout has no horizontal overflow', async ({ app, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open(entry);
  await expect(browser.locator('.store-chip')).toBeVisible();
  expect(
    await browser.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});
