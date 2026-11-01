/* global location, document, window */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Synthetic fixture from server.ts: `sample-source` has untracked Acme.txt and src/, and the
// `sample` profile renames Acme to Northwind. `.env` is gitignored there.
const entry = '/#token=browser-test-token';

async function openSheet(app: { open(path: string): Promise<unknown> }, browser: never) {
  await app.open(entry);
  const page = browser as unknown as {
    locator(selector: string): {
      selectOption(value: { label: string }): Promise<void>;
      waitFor(): Promise<void>;
    };
    evaluate(action: () => void): Promise<unknown>;
  };
  await page.locator('.store-chip').waitFor();
  await page.evaluate(() => {
    location.hash = '#/new';
  });
  await page.locator('.new-banner select').selectOption({ label: 'sample-source' });
}

test('new cloak: reviews a selection live and creates the cloak', async ({ app, browser }) => {
  await openSheet(app, browser as never);
  await expect(browser.locator('.new-banner-place')).toContainText('main');
  await expect(browser.locator('.file-chip').first()).toBeVisible();
  await expect(browser.locator('.tree')).toContainText('src/');
  await expect(browser.locator('.tree')).not.toContainText('.env');
  // The profile chip is the only one in the fixture, so it starts on.
  await expect(browser.locator('.profile-chip-on')).toContainText('sample');
  const aside = browser.locator('aside.review');
  await expect(aside).toContainText('Acme');
  await expect(aside).toContainText('Northwind');
  await expect(aside).toContainText('src/Northwind.ts');
  await expect(aside).toContainText('repo-cloak pull --working -p sample');
  const create = browser.locator('.review-create');
  await expect(create).toContainText('Create cloak · 4 files');
  await expect(create).toBeEnabled();
  await create.click();
  await expect(browser.locator('main')).not.toHaveAttribute('aria-label', 'New cloak');
  expect(await browser.evaluate(() => location.hash)).toMatch(/^#\/ws\//);
  await expect(browser.locator('.rail-foot')).toContainText('2 workspaces');
});

test('new cloak: an existing cloak offers open, add and new', async ({ app, browser }) => {
  await openSheet(app, browser as never);
  const banner = browser.locator('.new-banner-existing');
  await expect(banner).toContainText('Already cloaked as');
  await expect(browser.locator('.new-banner-existing a')).toContainText('Open it');
  await browser.locator('.segment button:first-child').click();
  await expect(browser.locator('.review-create')).toContainText('Add to');
  await expect(browser.locator('.sheet-row')).toHaveCount(0);
  await browser.locator('.segment button:last-child').click();
  await expect(browser.locator('.sheet-row')).toBeVisible();
});

test('new cloak: esc cancels, and the sheet fits a phone', async ({ app, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await openSheet(app, browser as never);
  await expect(browser.locator('aside.review')).toContainText('Northwind');
  expect(
    await browser.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await browser.keyboard.press('Escape');
  await expect(browser.locator('main')).not.toHaveAttribute('aria-label', 'New cloak');
});

test('first run: shows the state and saves presets', async ({ app, browser }) => {
  await app.open(entry);
  await expect(browser.locator('.store-chip')).toBeVisible();
  await browser.evaluate(() => {
    location.hash = '#/setup';
  });
  const key = browser.locator('section[aria-label="Create your key"]');
  await expect(key).toContainText('key file');
  const presets = browser.locator('section[aria-label="Never pull these"]');
  await expect(presets).toContainText('presets on');
  await browser.locator('section[aria-label="Never pull these"] .step-action button').click();
  await expect(presets).toContainText('.env.*');
  await browser.locator('section[aria-label="Never pull these"] .step-buttons button').click();
  await expect(browser.locator('section[aria-label="Never pull these"] .step-mark')).toContainText(
    '✓',
  );
});

test('first run: fits a phone', async ({ app, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open(entry);
  await expect(browser.locator('.store-chip')).toBeVisible();
  await browser.evaluate(() => {
    location.hash = '#/setup';
  });
  await expect(browser.locator('section[aria-label="First profile"]')).toBeVisible();
  expect(
    await browser.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});
