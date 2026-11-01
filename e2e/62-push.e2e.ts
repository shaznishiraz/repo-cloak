/* global document, fetch, setTimeout, window */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The fixture pulls Acme.txt into a cloak as Northwind.txt and edits it there. These journeys run
// in order on one server, so the post-check goes first: it is the one that needs no push yet.
const entry = '/#token=browser-test-token';
type Page = Parameters<Parameters<typeof test>[1]>[0];

async function open(page: Pick<Page, 'app' | 'browser'>) {
  await page.app.open(entry);
  await expect(page.browser.locator('.store-chip')).toBeVisible();
  const place = await page.browser.evaluate(async () => {
    const response = await fetch('/api/v2/overview', {
      headers: { Authorization: 'Bearer browser-test-token' },
    });
    const overview = (await response.json()) as {
      workspaces: { id: string; name: string; path: string; lineage: { repo: { path: string } } }[];
    };
    const found = overview.workspaces.find((item) => item.name === 'sample-workspace');
    if (!found) throw new Error('Fixture workspace missing');
    return { id: found.id, cloak: found.path, source: found.lineage.repo.path };
  });
  await page.browser.evaluate((id) => {
    window.location.hash = `#/ws/${encodeURIComponent(id)}/push`;
  }, place.id);
  await expect(page.browser.locator('.push-head')).toBeVisible();
  return place;
}
const go = (page: Pick<Page, 'browser'>) => page.browser.locator('.push-go');
const absent = async (path: string) =>
  readFile(path, 'utf8').then(
    () => false,
    () => true,
  );
const noOverflow = (page: Pick<Page, 'browser'>) =>
  page.browser.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('runs the post-check only after a push, a click and a confirmation', async (page) => {
  const place = await open(page);
  const { browser, screen } = page;
  const marker = join(place.source, 'post-check-ran.txt');
  const command = `echo checked in "$PWD"; env; touch post-check-ran.txt; exit 3`;
  const block = browser.locator('.push-post-check');
  await expect(block).toBeVisible();
  await block.getByLabel('Command, run only when you click').fill(command);
  await screen.getByRole('button', { name: 'Save' }).click();
  await expect(block).toContainText('Available after a push.');
  await expect(screen.getByRole('button', { name: 'Run post-check' })).toBeDisabled();

  await writeFile(join(place.cloak, 'Northwind.txt'), 'Edited again Northwind\n');
  await browser.reload();
  await expect(go(page)).toBeEnabled();
  await go(page).click();
  await expect(browser.locator('.push-result')).toContainText('Pushed 1 file');
  await new Promise((done) => setTimeout(done, 500));
  expect(await absent(marker)).toBe(true);

  await screen.getByRole('button', { name: 'Run post-check' }).click();
  const dialog = browser.locator('dialog[open]');
  await expect(dialog).toContainText(command);
  await expect(dialog).toContainText('not sandboxed');
  await screen.getByRole('button', { name: 'Cancel' }).click();
  expect(await absent(marker)).toBe(true);

  await screen.getByRole('button', { name: 'Run post-check' }).click();
  await screen.getByRole('button', { name: 'Run it' }).click();
  await expect(block).toContainText('Failed · exit 3');
  await expect(browser.locator('.push-output')).toContainText(`checked in ${place.source}`);
  await expect(browser.locator('.push-output')).not.toContainText('browser-test-token');
  expect(await absent(marker)).toBe(false);
  await rm(marker);
  expect(await noOverflow(page)).toBe(true);
});

test('pushes the selected file and leaves the other pending', async (page) => {
  const place = await open(page);
  const { browser, screen } = page;
  await writeFile(join(place.cloak, 'Northwind.txt'), 'Edited Northwind\n');
  await writeFile(join(place.cloak, 'NorthwindExtra.txt'), 'Extra Northwind\n');
  await browser.reload();
  await expect(browser.locator('.push-files-head')).toContainText('2 of 2 files');
  await screen.getByRole('checkbox', { name: 'Include AcmeExtra.txt' }).click();
  await expect(browser.locator('.push-files-head')).toContainText('1 of 2 files');
  await expect(go(page)).toContainText('Push 1 file');
  await go(page).click();
  await expect(browser.locator('.push-result')).toContainText('Pushed 1 file');
  expect(await readFile(join(place.source, 'Acme.txt'), 'utf8')).toBe('Edited Acme\n');
  expect(await absent(join(place.source, 'AcmeExtra.txt'))).toBe(true);
  // The one left out is still there, intact, and pushable.
  await expect(browser.locator('.push-files')).toContainText('AcmeExtra.txt');
  expect(await readFile(join(place.cloak, 'NorthwindExtra.txt'), 'utf8')).toBe('Extra Northwind\n');
  await go(page).click();
  await expect(browser.locator('.push-main')).toContainText('Nothing to push');
  expect(await readFile(join(place.source, 'AcmeExtra.txt'), 'utf8')).toBe('Extra Acme\n');
});

test('confirms a deletion through the server, and only for what is selected', async (page) => {
  const place = await open(page);
  const { browser, screen } = page;
  await rm(join(place.cloak, 'NorthwindExtra.txt'));
  await browser.reload();
  await expect(browser.locator('.push-files')).toContainText('AcmeExtra.txt');
  await go(page).click();
  await expect(browser.locator('dialog[open]')).toContainText('AcmeExtra.txt');
  await screen.getByRole('button', { name: 'Cancel' }).click();
  expect(await readFile(join(place.source, 'AcmeExtra.txt'), 'utf8')).toBe('Extra Acme\n');

  // A client that skips the dialog is refused by the server, whatever the screen does.
  const refused = await browser.evaluate(async (id) => {
    const headers = {
      Authorization: 'Bearer browser-test-token',
      'Content-Type': 'application/json',
    };
    const overview = (await (await fetch('/api/v2/overview', { headers })).json()) as {
      workspaces: { id: string; repoId: string }[];
    };
    const repoId = overview.workspaces.find((item) => item.id === id)?.repoId ?? '';
    const base = `/api/v2/push/${repoId}/${encodeURIComponent(id)}`;
    const review = (await (
      await fetch(`${base}/review`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ target: { kind: 'origin' } }),
      })
    ).json()) as { operationId: string };
    const response = await fetch(`${base}/apply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationId: review.operationId,
        mode: 'write',
        repull: false,
        includeGroupMembers: false,
        mergeMode: 'merge',
      }),
    });
    return { status: response.status, body: (await response.json()) as { error: string } };
  }, place.id);
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain('Confirm the listed deletions');
  expect(await readFile(join(place.source, 'AcmeExtra.txt'), 'utf8')).toBe('Extra Acme\n');

  await browser.reload();
  await go(page).click();
  await screen.getByRole('button', { name: 'Delete and push' }).click();
  await expect(browser.locator('.push-result')).toContainText('Pushed 1 file');
  expect(await absent(join(place.source, 'AcmeExtra.txt'))).toBe(true);
});

test('the selection and post-check stay usable at phone width', async (page) => {
  await page.browser.setViewport({ width: 390, height: 844 });
  const place = await open(page);
  await writeFile(join(place.cloak, 'Northwind.txt'), 'Phone Northwind\n');
  await page.browser.reload();
  await expect(page.browser.locator('.push-files-head input')).toBeVisible();
  await expect(page.browser.locator('.push-post-check')).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});
