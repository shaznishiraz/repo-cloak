/* global fetch, location */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Writes synthetic files into the temporary fixture from server.ts, found through its own API.
const entry = '/#token=browser-test-token';
type Page = { evaluate<T>(action: () => Promise<T> | T): Promise<T> };
type Fixture = { repos: { name: string; path: string }[]; workspaces: { path: string }[] };

function overview(browser: unknown) {
  return (browser as Page).evaluate(() =>
    fetch('/api/v2/overview', { headers: { Authorization: 'Bearer browser-test-token' } }).then(
      (response) => response.json() as Promise<Fixture>,
    ),
  );
}

test('home: a quiet scan is not called safe, and a server name is a labelled warning', async ({
  app,
  browser,
}) => {
  await app.open(entry);
  const guard = browser.locator('[data-guard="leak-heuristics"]');
  await expect(guard).toContainText('Heuristic scan spotted no likely leftovers');
  await expect(guard).toContainText('not proof');
  await expect(browser.locator('[data-guard="leaks"]')).toContainText('from the ledger');
  const { workspaces } = await overview(browser);
  const [workspace] = workspaces;
  if (!workspace) throw new Error('Fixture has no workspace');
  await writeFile(join(workspace.path, 'notes.txt'), 'connect to ch-prod-sql01\n');
  await browser.reload();
  await expect(guard).toContainText('1 possible leftover name (heuristic)');
  await expect(guard).toContainText('ch-prod-sql01 · server · notes.txt');
  await expect(guard).toHaveAttribute('data-state', 'warning');
  await expect(browser.locator('[data-guard="leaks"]')).toHaveAttribute('data-state', 'ok');
});

test('new cloak: a heuristic finding must be acknowledged before create', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await browser.locator('.store-chip').waitFor();
  const { repos } = await overview(browser);
  const source = repos.find((repo) => repo.name === 'sample-source');
  if (!source) throw new Error('Fixture has no source');
  await (browser as unknown as Page).evaluate(() => {
    location.hash = '#/new';
  });
  await browser.locator('.new-banner select').selectOption({ label: 'sample-source' });
  const note = browser.locator('[data-leak-scan]');
  await expect(note).toContainText('Spotted no likely leftovers');
  await expect(note).toContainText('not proof of safety');
  await writeFile(join(source.path, 'notes.txt'), 'connect to ch-prod-sql01\n');
  await browser.reload();
  await browser.locator('.new-banner select').selectOption({ label: 'sample-source' });
  const aside = browser.locator('aside.review');
  await expect(aside).toContainText('ch-prod-sql01 · server in notes.txt');
  const create = browser.locator('.review-create');
  await expect(create).toBeDisabled();
  await screen.getByRole('button', { name: 'Ignore' }).click();
  await expect(create).toBeEnabled();
});
