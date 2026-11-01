/* global document, window, fetch */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The fixture in server.ts has one workspace with an edited file, a queued agent request, a linked
// worktree and a second repository. Journeys run in order and share that store.
const entry = '/#token=browser-test-token';
const row = '.ws-row';

test('home lists the workspace with its lineage, stats and panels', async ({ app, browser }) => {
  await app.open(entry);
  await expect(browser.locator(row)).toContainText('sample-workspace');
  await expect(browser.locator(row)).toContainText('↑1 to push');
  await expect(browser.locator('.ws-lineage')).toContainText('sample-source');
  await expect(browser.locator('.ws-lineage')).toContainText('sample-workspace');
  await expect(browser.locator('.ws-stat')).toHaveCount(7);
  await expect(browser.locator('.ws-change')).toContainText('Northwind.txt');
  await expect(browser.locator('.ws-change')).toContainText('→ Acme.txt');
  await expect(browser.locator('[data-guard="reversal"]')).toBeVisible();
  await expect(browser.locator('[data-guard="leaks"]')).toContainText('No real names');
  await expect(browser.locator('.ws-request')).toContainText('src/Northwind.ts');
  await expect(browser.locator('.ws-request')).toContainText('Need the class definition');
});

test('the needs action filter hides nothing while work is pending', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await expect(browser.locator(row)).toHaveCount(1);
  await screen.getByRole('button', { name: 'Needs action' }).click();
  await expect(browser.locator(row)).toHaveCount(1);
});

test('push targets offer a dry run that shows the restored diff', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await expect(browser.locator('.ws-change')).toBeVisible();
  await screen.getByRole('button', { name: 'Push target options' }).click();
  await expect(screen.getByRole('menuitem', { name: /Worktree it came from/ })).toBeVisible();
  await expect(screen.getByRole('menuitem', { name: /Main repo checkout/ })).toBeVisible();
  await expect(screen.getByRole('menuitem', { name: /Another worktree/ })).toBeVisible();
  await expect(screen.getByRole('menuitem', { name: /New worktree from main/ })).toBeVisible();
  await expect(screen.getByRole('menuitem', { name: 'Export restored .patch' })).toBeVisible();
  await screen.getByRole('menuitem', { name: /Dry run/ }).click();
  await expect(browser.locator('.op-patch')).toContainText('Edited Acme');
  await expect(screen.getByRole('button', { name: 'Apply' })).toBeHidden();
  await screen.getByRole('button', { name: 'Close' }).click();
  await expect(browser.locator(row)).toContainText('↑1 to push');
});

test('a group is created, run in bulk and listed on the home screen', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await expect(browser.locator(row)).toBeVisible();
  await screen.getByRole('button', { name: '+ Group' }).click();
  await screen.getByLabel('Name').fill('browser-group');
  await browser.locator('.dialog .check input').first().check();
  await screen.getByRole('button', { name: 'Save group' }).click();
  await expect(browser.locator('.grp-head')).toContainText('browser-group');
  await expect(browser.locator('.grp-row[data-repo]')).toContainText('push → same worktree');
  await expect(browser.locator('.grp-row[data-repo]')).toContainText('write 1 file');
  await expect(browser.locator('.grp')).toContainText('No shared folder yet');
  await expect(browser.locator('.grp')).toContainText('Stop all if any guard check fails');
  await expect(browser.locator('.rail')).toContainText('browser-group');

  await browser.locator('.grp-head-actions .ws-push button').click();
  await expect(screen.getByLabel('Commit message for every repo')).toBeVisible();
  await screen.getByRole('button', { name: 'Preview' }).click();
  await expect(browser.locator('.dialog')).toContainText('Acme.txt');
  await screen.getByRole('button', { name: 'Apply' }).click();
  await expect(browser.locator('.toasts')).toContainText('Push complete for browser-group');
  await expect(browser.locator('.grp-runs')).toContainText('push');
  await expect(browser.locator('.grp-row[data-repo]')).toContainText('nothing to do');

  await browser.evaluate(() => {
    location.hash = '#/';
  });
  await expect(browser.locator('.ws-section-head a')).toHaveAttribute('href', /#\/groups\//);
  await expect(browser.locator(row)).toContainText('clean');
});

test('history shows the push and the panels settle after it', async ({ app, browser }) => {
  await app.open(entry);
  await expect(browser.locator('.ws-history')).toContainText('push');
  await expect(browser.locator('.ws-panel').first()).toContainText('Nothing to push');
  await expect(browser.locator('.ws-stat').last()).not.toContainText('never');
});

test('a clean workspace pulls through a preview', async ({ app, browser, screen }) => {
  await app.open(entry);
  await expect(browser.locator('.ws-change')).toHaveCount(0);
  await browser.locator('.ws-actions .btn').first().click();
  await screen.getByRole('button', { name: 'Apply' }).click();
  await expect(browser.locator('.toasts')).toContainText('Pull complete');
  await expect(browser.locator('.ws-history')).toContainText('pull');
});

test('home and group fit a phone and a menu stays on screen', async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open(entry);
  await expect(browser.locator('.ws-detail')).toBeVisible();
  const fits = () =>
    browser.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await fits()).toBe(true);
  await screen.getByRole('button', { name: 'Push target options' }).click();
  const menu = await browser.locator('.ws-push .menu-list').boundingBox();
  expect(menu?.x).toBeGreaterThanOrEqual(0);
  expect((menu?.x ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(390);
  await browser.evaluate(async () => {
    const token = 'browser-test-token';
    const response = await fetch('/api/v2/groups', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { groups } = await response.json();
    location.hash = `#/groups/${groups[0].id}`;
  });
  await expect(browser.locator('.grp-head')).toBeVisible();
  expect(await fits()).toBe(true);
});

test('an unknown group explains itself', async ({ app, browser }) => {
  await app.open(entry);
  await browser.evaluate(() => {
    location.hash = '#/groups/00000000-0000-4000-8000-000000000000';
  });
  await expect(browser.locator('.screen')).toContainText('Could not load this group');
});
