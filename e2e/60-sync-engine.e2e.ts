/* global fetch */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// Everything here is the synthetic fixture from server.ts, in its temporary folder.
const entry = '/#token=browser-test-token';
const identity = [
  '-c',
  'user.email=b@example.test',
  '-c',
  'user.name=b',
  '-c',
  'commit.gpgSign=false',
];

test('pull from a commit shows the commit and writes its content, not the dirty worktree', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await expect(browser.locator('.ws-row')).toBeVisible();
  const { source, workspace } = await browser.evaluate(async () => {
    const response = await fetch('/api/v2/overview', {
      headers: { Authorization: 'Bearer browser-test-token' },
    });
    const overview = (await response.json()) as {
      repos: { name: string; path: string }[];
      workspaces: { path: string }[];
    };
    return {
      source: overview.repos.find((repo) => repo.name === 'sample-source')?.path ?? '',
      workspace: overview.workspaces[0]?.path ?? '',
    };
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, encoding: 'utf8' });
  writeFileSync(join(source, 'Picked.txt'), 'Committed Acme\n');
  git('add', 'Picked.txt');
  git(...identity, 'commit', '-qm', 'picked');
  const sha = git('rev-parse', 'HEAD').trim();
  writeFileSync(join(source, 'Picked.txt'), 'Dirty Acme\n');

  await screen.getByRole('button', { name: 'Pull options' }).click();
  await screen.getByRole('menuitem', { name: /Another worktree or commit/ }).click();
  await screen.getByLabel('Or pull the files changed by a commit').fill(sha);
  await screen.getByRole('button', { name: 'Preview' }).click();
  await expect(browser.locator('.op-commit')).toContainText(sha.slice(0, 12));
  await expect(browser.locator('.dialog')).toContainText('Picked.txt');
  await screen.getByRole('button', { name: 'Apply' }).click();
  await expect(browser.locator('.toasts')).toContainText('Pull complete');
  expect(readFileSync(join(workspace, 'Picked.txt'), 'utf8')).toBe('Committed Northwind\n');
});

test('an unknown commit is reported and nothing can be applied', async ({
  app,
  browser,
  screen,
}) => {
  await app.open(entry);
  await expect(browser.locator('.ws-row')).toBeVisible();
  await screen.getByRole('button', { name: 'Pull options' }).click();
  await screen.getByRole('menuitem', { name: /Another worktree or commit/ }).click();
  await screen.getByLabel('Or pull the files changed by a commit').fill('no-such-branch');
  await screen.getByRole('button', { name: 'Preview' }).click();
  await expect(browser.locator('.dialog')).toContainText('Commit not found: no-such-branch');
  await expect(screen.getByRole('button', { name: 'Apply' })).toBeHidden();
});
