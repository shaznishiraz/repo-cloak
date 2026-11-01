/* global location, document, window */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The fixture in server.ts registers two sources, one workspace and one agent request.
const entry = '/#token=browser-test-token';
const go = (
  browser: { evaluate: (fn: (hash: string) => void, hash: string) => Promise<void> },
  hash: string,
) =>
  browser.evaluate((next) => {
    location.hash = next;
  }, hash);
const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;

test('known repos shows worktrees and pins, edits exclusions', async ({ app, browser, screen }) => {
  await app.open(entry);
  await go(browser, '#/repos');
  const repos = screen.getByRole('region', { name: 'Repositories' });
  await expect(repos).toContainText('sample-source');
  await expect(repos).toContainText('z-new-source');
  await repos.getByRole('button', { name: /^sample-source / }).click();
  const detail = screen.getByRole('region', { name: 'Repository detail' });
  await expect(detail).toContainText('secondary');
  await expect(detail).toContainText('sample-workspace');
  await expect(detail.getByRole('link', { name: 'Open' })).toBeVisible();
  await expect(detail.getByRole('link', { name: 'Cloak' })).toBeVisible();

  await repos.getByRole('button', { name: 'Pin z-new-source' }).click();
  await expect(repos.getByRole('button', { name: 'Unpin z-new-source' })).toBeVisible();

  await detail.getByRole('button', { name: 'Edit exclusions' }).click();
  await browser.locator('.dialog[open] textarea').fill('**/generated/**');
  await browser.locator('.dialog[open] .btn-primary').click();
  await expect(detail).toContainText('**/generated/**');
});

test('an agent request is reviewed against a cloaked preview, then pulled', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await go(browser, '#/requests');
  const list = screen.getByRole('region', { name: 'Requests' });
  await expect(list).toContainText('src/Northwind.ts');
  const detail = screen.getByRole('region', { name: 'Request detail' });
  await expect(detail).toContainText('Need the class definition');
  await expect(detail).toContainText('Source, exclusions and profiles re-checked');
  await expect(browser.locator('pre.adm-code')).toContainText('class Northwind {}');
  await expect(detail.getByRole('button', { name: 'Send signatures only' })).toBeDisabled();
  await detail.getByRole('button', { name: 'Approve & pull' }).click();
  await expect(browser.locator('.toasts')).toContainText('Pulled src/Northwind.ts');
  await expect(list).toContainText('Nothing waiting');
  await screen.getByRole('tab', { name: 'Decided' }).click();
  await expect(list).toContainText('src/Northwind.ts');
  await expect(detail).toContainText('pulled');
});

test('history filters events, verifies the chain and exports', async ({ app, browser, screen }) => {
  await app.open(entry);
  await go(browser, '#/settings');
  const lock = browser.locator('input[placeholder="off"]');
  await lock.fill('240');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(browser.locator('.toasts')).toContainText('Settings saved');
  await lock.fill('');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();

  await go(browser, '#/history');
  await expect(browser.locator('.adm-head')).toContainText('chain verified');
  const events = screen.getByRole('region', { name: 'Events' });
  await expect(events).toContainText('settings');
  await browser.locator('.adm-aside').waitFor();
  await expect(browser.locator('.adm-aside')).toContainText('event #');
  const filter = browser.locator('.adm-filter input');
  await filter.fill('op:nope');
  await expect(browser.locator('.adm-head')).toContainText('op: use one of');
  await filter.fill('op:settings since:7d');
  await expect(events).toContainText('settings');
  await expect(events).not.toContainText('nothing-matches');
  await filter.fill('op:delete');
  await expect(events).toContainText('No events match');
  await screen.getByRole('button', { name: 'Export signed log' }).click();
  await expect(browser.locator('.toasts')).toContainText('signing key fingerprint');
});

test('settings shows every section and locking ends the session', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await go(browser, '#/settings');
  for (const name of [
    /^Workspaces/,
    /^Security/,
    /^Global exclusions/,
    /^Audit & compliance/,
    /^Runs locally/,
    /^AI tools/,
  ])
    await expect(screen.getByRole('heading', { name })).toBeVisible();
  await expect(browser.locator('.adm-stats')).toContainText('direct dependencies');
  await expect(browser.locator('#settings-integrations')).toContainText('repo-cloak-');
  await screen.getByRole('button', { name: 'Verify chain' }).click();
  await expect(browser.locator('#settings-compliance')).toContainText('chain verified');
});

test('every admin screen fits the phone width', async ({ app, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open(entry);
  for (const hash of ['#/repos', '#/requests', '#/history', '#/settings']) {
    await go(browser, hash);
    await browser.locator(`main.screen`).waitFor();
    await browser.locator('.adm-head').waitFor();
    expect(await browser.evaluate(noOverflow), hash).toBe(true);
  }
});
