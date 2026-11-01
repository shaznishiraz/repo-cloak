/* global document, fetch, setTimeout, window */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The fixture in server.ts pulls Acme.txt into a cloak as Northwind.txt and edits it there.
const entry = '/#token=browser-test-token';
type Page = Parameters<Parameters<typeof test>[1]>[0];

async function locate({ browser }: Pick<Page, 'browser'>) {
  return browser.evaluate(async () => {
    const response = await fetch('/api/v2/overview', {
      headers: { Authorization: 'Bearer browser-test-token' },
    });
    const overview = (await response.json()) as {
      workspaces: {
        id: string;
        name: string;
        path: string;
        lineage: { repo: { path: string } };
      }[];
    };
    const found = overview.workspaces.find((item) => item.name === 'sample-workspace');
    if (!found) throw new Error('Fixture workspace missing');
    return { id: found.id, cloak: found.path, source: found.lineage.repo.path };
  });
}
async function open(page: Pick<Page, 'app' | 'browser'>) {
  await page.app.open(entry);
  await expect(page.browser.locator('.store-chip')).toBeVisible();
  const place = await locate(page);
  await page.browser.evaluate((id) => {
    window.location.hash = `#/ws/${encodeURIComponent(id)}/push`;
  }, place.id);
  await expect(page.browser.locator('.push-head')).toBeVisible();
  return place;
}
const noOverflow = (page: Pick<Page, 'browser'>) =>
  page.browser.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** The server finishes after the click returns, so wait for the file rather than the screen. */
async function fileBecomes(path: string, expected: string) {
  let text = '';
  for (let tries = 0; tries < 100; tries++) {
    text = await readFile(path, 'utf8');
    if (text === expected) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  expect(text).toBe(expected);
}
const go = (page: Pick<Page, 'browser'>) => page.browser.locator('.push-go');

test('reviews the edit side by side and passes the checks', async (page) => {
  await open(page);
  const { browser, screen } = page;
  await expect(browser.locator('.push-files')).toContainText('Acme.txt');
  await expect(browser.locator('.push-lines')).toContainText('Edited Northwind');
  await expect(browser.locator('.push-lines')).toContainText('Edited Acme');
  await expect(browser.locator('[data-check="restores"]')).toContainText(
    'Every cloaked name restores',
  );
  await expect(browser.locator('[data-check="no-leak"]')).toContainText('0 hits after restore');
  await expect(browser.locator('[data-check="manifest"]')).toContainText(
    'Only files from this cloak',
  );
  await screen.getByRole('tab', { name: 'Restored diff only' }).click();
  await expect(browser.locator('.push-lines')).toContainText('Edited Acme');
  await expect(browser.locator('.push-lines')).not.toContainText('Edited Northwind');
  expect(await noOverflow(page)).toBe(true);
});

test('stays usable at phone width', async (page) => {
  await page.browser.setViewport({ width: 390, height: 844 });
  await open(page);
  await expect(page.browser.locator('.push-lines')).toContainText('Edited Acme');
  await expect(go(page)).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});

test('a dry run writes nothing and cannot be pushed', async (page) => {
  const place = await open(page);
  await page.browser.locator('.push-into select').selectOption('dry run · write nothing');
  await expect(page.browser.locator('.push-why')).toContainText('Dry run');
  await expect(go(page)).toBeDisabled();
  expect(await readFile(join(place.source, 'Acme.txt'), 'utf8')).toBe('Hello Acme\n');
});

test('pushes, keeps a backup, and undo puts the edit back to pending', async (page) => {
  const place = await open(page);
  const { browser, screen } = page;
  await expect(go(page)).toContainText('Push 1 file');
  await go(page).click();
  await expect(browser.locator('.push-result')).toContainText('Pushed 1 file');
  expect(await readFile(join(place.source, 'Acme.txt'), 'utf8')).toBe('Edited Acme\n');
  await expect(browser.locator('.push-main')).toContainText('Nothing to push');

  await screen.getByRole('button', { name: 'undo', exact: true }).click();
  await screen.getByRole('button', { name: 'Restore from backup' }).click();
  await fileBecomes(join(place.source, 'Acme.txt'), 'Hello Acme\n');
  await expect(screen.getByRole('button', { name: 'undo', exact: true })).toBeHidden();
});

test('an overlapping source change needs a confirmed overwrite, then undoes', async (page) => {
  const place = await open(page);
  const { browser, screen } = page;
  await writeFile(join(place.source, 'Acme.txt'), 'Upstream Acme\n');
  await browser.reload();
  await expect(browser.locator('.push-note')).toContainText(
    'changed in the source after you pulled',
  );
  await expect(browser.locator('.push-files')).toContainText('overlaps');
  await expect(go(page)).toBeDisabled();
  await expect(screen.getByRole('button', { name: 'Merge (recommended)' })).toBeDisabled();
  await screen.getByRole('button', { name: 'Overwrite', exact: true }).click();
  await screen.getByRole('button', { name: 'Overwrite source files' }).click();
  await go(page).click();
  await expect(browser.locator('.push-result')).toContainText('Pushed 1 file');
  expect(await readFile(join(place.source, 'Acme.txt'), 'utf8')).toBe('Edited Acme\n');
  await screen.getByRole('button', { name: 'undo', exact: true }).click();
  await screen.getByRole('button', { name: 'Restore from backup' }).click();
  await fileBecomes(join(place.source, 'Acme.txt'), 'Upstream Acme\n');
  await expect(browser.locator('.push-files')).toContainText('Acme.txt');
  await writeFile(join(place.source, 'Acme.txt'), 'Hello Acme\n');
});

test('a source change that does not overlap merges cleanly', async (page) => {
  const place = await open(page);
  const { browser } = page;
  const body = (name: string, first: string, last: string) =>
    `${first}\n${[2, 3, 4, 5, 6, 7, 8, 9].map((at) => `line ${at} ${name}`).join('\n')}\n${last}\n`;
  await writeFile(join(place.cloak, 'Northwind.txt'), body('Northwind', 'first', 'last'));
  await browser.reload();
  await expect(go(page)).toBeEnabled();
  await go(page).click();
  await expect(browser.locator('.push-result')).toContainText('Pushed 1 file');
  await expect(browser.locator('.push-main')).toContainText('Nothing to push');

  await writeFile(join(place.cloak, 'Northwind.txt'), body('Northwind', 'first', 'cloak last'));
  await writeFile(join(place.source, 'Acme.txt'), body('Acme', 'upstream first', 'last'));
  await browser.reload();
  await expect(browser.locator('.push-files')).toContainText('auto-merge');
  await expect(browser.locator('.push-note')).toContainText('3-way merge applies cleanly');
  await go(page).click();
  await expect(browser.locator('.push-result')).toContainText('Pushed 1 file');
  expect(await readFile(join(place.source, 'Acme.txt'), 'utf8')).toBe(
    body('Acme', 'upstream first', 'cloak last'),
  );
  // The default re-pull brings the upstream line into the cloak.
  expect(await readFile(join(place.cloak, 'Northwind.txt'), 'utf8')).toBe(
    body('Northwind', 'upstream first', 'cloak last'),
  );
});
