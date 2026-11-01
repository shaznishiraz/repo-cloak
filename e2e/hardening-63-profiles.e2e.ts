/* global location */
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The fixture in server.ts has one global profile, "sample": Acme -> Northwind.
const entry = '/#token=browser-test-token';
async function openSample(app, browser, screen) {
  await app.open(entry);
  await expect(browser.locator('.store-chip')).toBeVisible();
  await browser.evaluate(() => {
    location.hash = '#/profiles';
  });
  await expect(screen.getByLabel('Find for rule 1')).toHaveValue('Acme');
}
function withRegex(text, match) {
  const doc = JSON.parse(text);
  doc.rules.push({ id: 'pattern', type: 'regex', match, replace: 'x$&' });
  return JSON.stringify(doc, null, 2);
}

test('JSON mode refuses a catastrophic regex by rule', async ({ app, browser, screen }) => {
  await openSample(app, browser, screen);
  await screen.getByRole('tab', { name: 'JSON' }).click();
  const editor = screen.getByLabel('Profile JSON');
  const text = await editor.inputValue();
  await editor.fill(withRegex(text, '(a+)+$'));
  await expect(browser.locator('[aria-label="Problems"]')).toContainText('unsafe regex');
  await expect(screen.getByRole('button', { name: /fix \d+ error/ })).toBeDisabled();
});

test('the tester reports a regex that runs out of time', async ({ app, browser, screen }) => {
  await openSample(app, browser, screen);
  await screen.getByRole('tab', { name: 'JSON' }).click();
  const editor = screen.getByLabel('Profile JSON');
  const text = await editor.inputValue();
  await editor.fill(withRegex(text, '^(.*?,){14}P'));
  await expect(browser.locator('[aria-label="Problems"]')).not.toContainText('unsafe regex');
  await screen.getByRole('tab', { name: 'Form' }).click();
  await screen.getByLabel('Paste source text').fill('a,'.repeat(4000));
  await expect(browser.locator('section[aria-label="Try it"]')).toContainText(
    'regex did not finish within 2s',
    { timeout: 15_000 },
  );
  // The rest of the dashboard is still alive.
  await expect(browser.locator('nav[aria-label="Profiles"]')).toContainText('sample');
});

test('a child profile shows its parent and roots, and protects the parent', async ({
  app,
  browser,
  screen,
}) => {
  await openSample(app, browser, screen);
  await screen.getByRole('button', { name: '+ Profile' }).click();
  await screen.getByRole('tab', { name: 'JSON' }).click();
  const editor = screen.getByLabel('Profile JSON');
  const child = {
    kind: 'profile',
    schemaVersion: 2,
    name: 'child',
    extends: ['nowhere'],
    allowRoots: ['src/'],
    rules: [],
  };
  await editor.fill(JSON.stringify(child, null, 2));
  await expect(browser.locator('[aria-label="Problems"]')).toContainText('not found');
  await editor.fill(JSON.stringify({ ...child, extends: ['sample'] }, null, 2));
  await expect(browser.locator('[aria-label="Problems"]')).not.toContainText('not found');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(browser.locator('nav[aria-label="Profiles"]')).toContainText('extends sample');
  await screen.getByRole('tab', { name: 'Form' }).click();
  await expect(browser.locator('.pf-panels')).toContainText('Files only from src/');

  await browser.locator('nav[aria-label="Profiles"]').getByText('sample', { exact: true }).click();
  await screen.getByRole('button', { name: 'Delete', exact: true }).click();
  await screen.getByRole('button', { name: 'Delete profile' }).click();
  await expect(browser.locator('body')).toContainText('child extend it');
  await expect(browser.locator('nav[aria-label="Profiles"]')).toContainText('sample');
});
