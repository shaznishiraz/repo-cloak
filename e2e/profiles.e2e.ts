/* global document, window, location */
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

test('the rules table shows real hits and saves an edit', async ({ app, browser, screen }) => {
  await openSample(app, browser, screen);
  await expect(browser.locator('nav[aria-label="Profiles"]')).toContainText('sample');
  await expect(browser.locator('[aria-label="Rule 1"] .pf-hits')).not.toHaveText('—');
  await screen.getByRole('button', { name: '+ Keyword' }).click();
  await screen.getByLabel('Find for rule 2').fill('Globex');
  await screen.getByLabel('Replace for rule 2').fill('Initech');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(browser.locator('.toasts')).toContainText('Profile saved');
  await browser.reload();
  await expect(screen.getByLabel('Find for rule 2')).toHaveValue('Globex');
  await expect(browser.locator('[aria-label="Rule 2"]')).toContainText('Keyword');
});

test('the tester cloaks text and checks the round trip', async ({ app, browser, screen }) => {
  await openSample(app, browser, screen);
  await screen.getByLabel('Paste source text').fill('class Acme {}');
  await expect(browser.locator('.pf-cloaked')).toHaveText('class Northwind {}');
  await expect(browser.locator('[aria-label="Round trip result"]')).toContainText(
    'identical to source',
  );
});

test('JSON mode blocks a broken save and locates the problem', async ({ app, browser, screen }) => {
  await openSample(app, browser, screen);
  await screen.getByRole('tab', { name: 'JSON' }).click();
  const editor = screen.getByLabel('Profile JSON');
  const text = await editor.inputValue();
  await editor.fill(text.replace('"replace": "Northwind"', '"replace": ""'));
  await expect(browser.locator('[aria-label="Problems"]')).toContainText(/Line \d+:/);
  await expect(screen.getByRole('button', { name: /fix \d+ error/ })).toBeDisabled();
  await expect(browser.locator('.pf-back .pf-line-err').first()).toBeVisible();
  await editor.fill(text);
  await expect(browser.locator('[aria-label="Problems"]')).toContainText('No problems');
});

test('Paste from LLM refuses secrets, and applies only accepted changes', async ({
  app,
  browser,
  screen,
}) => {
  await openSample(app, browser, screen);
  await screen.getByRole('tab', { name: 'JSON' }).click();
  await screen.getByRole('button', { name: 'Paste from LLM' }).click();
  const paste = screen.getByLabel('Pasted profile JSON');
  const base = { kind: 'profile', schemaVersion: 1, name: 'sample' };
  await paste.fill(
    JSON.stringify({
      ...base,
      rules: [{ id: 's', type: 'secret', detector: 'jwt', value: 'not-allowed-here' }],
    }),
  );
  await screen.getByRole('button', { name: 'Check and diff' }).click();
  await expect(browser.locator('dialog [role="alert"]')).toContainText('Refused');
  await expect(paste).toHaveValue('');
  await paste.fill(
    JSON.stringify({
      ...base,
      rules: [
        { id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' },
        { id: 'extra', type: 'literal', match: 'Globex', replace: 'Initech' },
      ],
      exclude: ['generated/'],
    }),
  );
  await screen.getByRole('button', { name: 'Check and diff' }).click();
  await screen.getByRole('checkbox', { name: /Rule extra/ }).check();
  await screen.getByRole('button', { name: 'Apply 1 accepted' }).click();
  const text = await screen.getByLabel('Profile JSON').inputValue();
  expect(text).toContain('Globex');
  expect(text).not.toContain('generated/');
});

test('a new profile can be created and deleted', async ({ app, browser, screen }) => {
  await openSample(app, browser, screen);
  await screen.getByRole('button', { name: '+ Profile' }).click();
  await screen.getByLabel('Profile name').fill('second');
  await screen.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(browser.locator('nav[aria-label="Profiles"]')).toContainText('second');
  // The list refreshes just before the route changes; Delete appears once the saved profile opens.
  await expect(screen.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  expect(await browser.evaluate(() => location.hash)).toMatch(/^#\/profiles\/pf_/);
  await screen.getByRole('button', { name: 'Delete', exact: true }).click();
  await screen.getByRole('button', { name: 'Delete profile' }).click();
  await expect(browser.locator('nav[aria-label="Profiles"]')).not.toContainText('second');
});

test('the palette reaches a profile', async ({ app, browser, screen }) => {
  await openSample(app, browser, screen);
  await browser.locator('.search').click();
  const input = screen.getByRole('combobox', { name: /^Command/ });
  await input.fill('New profile');
  await input.press('Enter');
  await expect(screen.getByLabel('Profile name')).toBeVisible();
});

test('profiles fit a phone without sideways scrolling', async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await openSample(app, browser, screen);
  const fits = () =>
    browser.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await fits()).toBe(true);
  await screen.getByRole('tab', { name: 'JSON' }).click();
  await expect(screen.getByLabel('Profile JSON')).toBeVisible();
  expect(await fits()).toBe(true);
});
