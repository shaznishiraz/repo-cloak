/* global location, sessionStorage, document, window, fetch, BroadcastChannel */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// A lock ends the fixture's first token for the rest of the server's life, so every test here
// gets its own token from the launcher route, which is what running repo-cloak again does.
type Browser = {
  url: () => Promise<string>;
  locator: (selector: string) => Parameters<typeof expect>[0];
};
async function launch(base: string) {
  const response = await fetch(`${base}/launcher/v1/session`, {
    method: 'POST',
    headers: { Authorization: 'Bearer browser-test-launcher' },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}
/** Opens the app once to learn its address, then signs in with a fresh token. */
async function signIn(app: { open: (path: string) => Promise<unknown> }, browser: Browser) {
  await app.open('/');
  const base = new URL(await browser.url()).origin;
  const token = await launch(base);
  await app.open(`/#token=${token}`);
  await expect(browser.locator('.rail')).toBeVisible();
  return { base, token };
}
const apiStatus = (token: string) => `fetch('/api/v2/overview', {
  headers: { Authorization: 'Bearer ${token}' },
}).then((response) => response.status)`;

test('locking shows the lock screen, kills the token, and a relaunch gets back in', async ({
  app,
  browser,
  screen,
}) => {
  const { base, token } = await signIn(app, browser);
  await browser.evaluate(() => {
    location.hash = '#/settings';
  });
  await screen.getByRole('button', { name: 'Lock dashboard now' }).click();
  await expect(screen.getByRole('heading', { name: 'Dashboard locked' })).toBeVisible();
  await expect(browser.locator('main[aria-label="Locked"]')).toContainText('repo-cloak');
  await expect(browser.locator('.rail')).toHaveCount(0);
  expect(await browser.evaluate(() => sessionStorage.getItem('cloak-token'))).toBeNull();
  expect(await browser.evaluate(apiStatus(token))).toBe(401);

  // A reload and the old link both stay locked.
  await browser.reload();
  await expect(screen.getByRole('heading', { name: 'Dashboard locked' })).toBeVisible();
  await app.open(`/#token=${token}`);
  await expect(screen.getByRole('heading', { name: 'Dashboard locked' })).toBeVisible();
  expect(await browser.evaluate(() => sessionStorage.getItem('cloak-token'))).toBeNull();

  // Unlocking is running repo-cloak again: a new fragment token, gone from the address at once.
  const fresh = await launch(base);
  expect(fresh).not.toBe(token);
  await app.open(`/#token=${fresh}`);
  await expect(browser.locator('.rail')).toBeVisible();
  expect(await browser.url()).not.toContain(fresh);
  expect(await browser.evaluate(apiStatus(fresh))).toBe(200);
  expect(await browser.evaluate(apiStatus(token))).toBe(401);
});

test('a lock in one tab locks another open tab', async ({ app, browser, screen }) => {
  const { base } = await signIn(app, browser);
  const second = await launch(base);
  await browser.evaluate((token) => {
    window.open(`/#token=${token}`, 'cloak-second-tab');
  }, second);
  const otherState = () =>
    browser.evaluate(() => {
      // A name finds the open tab again after this page reloads.
      const other = window.open('', 'cloak-second-tab') as Window;
      return {
        rail: !!other.document.querySelector('.rail'),
        locked: !!other.document.querySelector('main[aria-label="Locked"]'),
        token: other.sessionStorage.getItem('cloak-token'),
      };
    });
  await expect.poll(async () => (await otherState()).rail, { timeout: 10_000 }).toBe(true);
  await browser.evaluate(() => {
    location.hash = '#/settings';
  });
  await screen.getByRole('button', { name: 'Lock dashboard now' }).click();
  await expect(screen.getByRole('heading', { name: 'Dashboard locked' })).toBeVisible();
  await expect.poll(async () => (await otherState()).locked, { timeout: 10_000 }).toBe(true);
  expect((await otherState()).token).toBeNull();
  expect(await browser.evaluate(apiStatus(second))).toBe(401);
  await browser.evaluate(() => window.open('', 'cloak-second-tab')?.close());
});

test('a session revoked elsewhere locks this tab at its next request', async ({
  app,
  browser,
  screen,
}) => {
  const { base } = await signIn(app, browser);
  const other = await launch(base);
  const locked = await fetch(`${base}/api/v2/session/lock`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${other}` },
  });
  expect(locked.status).toBe(200);
  // Showing the tab refreshes at once, so this needs no wait for the 15 second poll.
  await browser.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(screen.getByRole('heading', { name: 'Dashboard locked' })).toBeVisible();
});

test('a message from another tab locks this one', async ({ app, browser, screen }) => {
  await signIn(app, browser);
  await browser.evaluate(() => {
    new BroadcastChannel('cloak-session').postMessage('lock');
  });
  await expect(screen.getByRole('heading', { name: 'Dashboard locked' })).toBeVisible();
  expect(await browser.evaluate(() => sessionStorage.getItem('cloak-token'))).toBeNull();
});

test('input tells the server, and an idle page sends no activity', async ({ app, browser }) => {
  const { token } = await signIn(app, browser);
  await browser.evaluate(
    `fetch('/api/v2/settings', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ${token}', 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoLockMinutes: 30 }),
    }).then((response) => response.status)`,
  );
  await browser.reload();
  await expect(browser.locator('.rail')).toBeVisible();
  const seen: string[] = [];
  await browser.route(/\/api\/v2\/session\/activity$/, async (route) => {
    seen.push(route.request.url);
    await route.continue();
  });
  // Settings are read shortly after load; several polls' worth of waiting would be slow here.
  await new Promise((done) => setTimeout(done, 1_000));
  await browser.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await new Promise((done) => setTimeout(done, 500));
  expect(seen).toHaveLength(0);
  await browser.locator('.rail').click({ position: { x: 2, y: 2 } });
  await expect.poll(() => seen.length, { timeout: 5_000 }).toBe(1);
  await browser.evaluate(
    `fetch('/api/v2/settings', {
      method: 'PUT',
      headers: { Authorization: 'Bearer ${token}', 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoLockMinutes: null }),
    }).then((response) => response.status)`,
  );
});

test('the inline picker in Settings browses, and fails over to typing', async ({
  app,
  browser,
  screen,
}) => {
  await signIn(app, browser);
  await browser.evaluate(() => {
    location.hash = '#/settings';
  });
  const root = screen.getByLabel('Cloak root');
  await root.fill('/usr');
  await screen.getByRole('button', { name: 'Browse' }).click();
  const folders = screen.getByRole('list', { name: 'Folders' });
  await folders.getByRole('button', { name: 'bin', exact: true }).click();
  await screen.getByRole('button', { name: 'Use this folder' }).click();
  await expect(root).toHaveValue('/usr/bin');

  await browser.route(/\/api\/v2\/folders/, (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Folder is unreadable' }),
    }),
  );
  await screen.getByRole('button', { name: 'Browse' }).click();
  await expect(browser.locator('[role="alert"]')).toContainText('Type the path instead');
  await root.fill('/typed/path');
  await expect(root).toHaveValue('/typed/path');
});

test('the dialog picker in Setup browses, and fails over to typing', async ({
  app,
  browser,
  screen,
}) => {
  await signIn(app, browser);
  await browser.evaluate(() => {
    location.hash = '#/setup';
  });
  await expect(browser.locator('main[aria-label="First run"]')).toBeVisible();
  const step = screen.getByRole('region', { name: /cloak|folder|root/i }).first();
  await step.getByRole('button').first().click();
  await screen.getByRole('button', { name: 'Browse' }).click();
  const path = screen.getByLabel('Folder path');
  await path.fill('/usr');
  await screen.getByRole('button', { name: 'Go' }).click();
  await screen
    .getByRole('list', { name: 'Folders' })
    .getByRole('button', { name: 'bin', exact: true })
    .click();
  await expect(path).toHaveValue('/usr/bin');
  await browser.route(/\/api\/v2\/folders/, (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Folder is unreadable' }),
    }),
  );
  await path.fill('/typed/path');
  await screen.getByRole('button', { name: 'Go' }).click();
  await expect(browser.locator('dialog [role="alert"]')).toContainText('Type the path instead');
  await screen.getByRole('button', { name: 'Use this folder' }).click();
  await expect(browser.locator('dialog [role="alert"]')).toHaveCount(0);
});
