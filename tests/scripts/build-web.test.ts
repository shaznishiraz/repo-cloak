import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildWeb } from '../../scripts/build-ui.js';

const budget = 280 * 1024;
let out: string;
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'cloak web build '));
  await buildWeb(out);
}, 60_000);
afterAll(() => rm(out, { recursive: true, force: true }));

it('emits the assets the server table serves', async () => {
  const files = await readdir(out);
  for (const name of ['index.html', 'app.js', 'app.css', 'favicon.svg', 'favicon.ico'])
    expect(files).toContain(name);
});

it('keeps JS, CSS and HTML within the 280 KB shipped-asset budget', async () => {
  const shipped = (await readdir(out)).filter((name) => /\.(js|css|html)$/.test(name));
  const sizes = await Promise.all(shipped.map(async (name) => (await stat(join(out, name))).size));
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(budget);
});

it('emits the supply-chain report Settings reads', async () => {
  const report = JSON.parse(await readFile(join(out, 'supply-chain.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  expect(report).toMatchObject({
    installScriptsAllowed: false,
    pinned: true,
    integrityHashes: true,
  });
  expect(report.bundledBrowserPackages).toEqual(
    expect.arrayContaining([expect.stringMatching(/^preact@\d/)]),
  );
});

it('references only same-origin assets so the page works under CSP self', async () => {
  const html = await readFile(join(out, 'index.html'), 'utf8');
  const css = await readFile(join(out, 'app.css'), 'utf8');
  expect(`${html}${css}`).not.toMatch(/https?:\/\//);
  expect(html).not.toMatch(/<script(?![^>]*src=)/);
  expect(html).not.toMatch(/\sstyle=/);
});
