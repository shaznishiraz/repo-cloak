import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { readJson } from '../../src/adapters/input.js';

it('reads piped JSON and accepts the UTF-8 BOM used by Windows editors', async () => {
  expect(await readJson('-', Readable.from(['\uFEFF{"name":', '"Müller"}']))).toEqual({
    name: 'Müller',
  });
});
it('reads JSON files with spaces in their paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak input '));
  try {
    const path = join(root, 'a profile.json');
    await writeFile(path, '\uFEFF{"name":"Müller"}');
    expect(await readJson(path)).toEqual({ name: 'Müller' });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
it('names the source on malformed input and refuses to wait on a terminal', async () => {
  await expect(readJson('-', Readable.from(['not JSON']))).rejects.toThrow(/-: invalid JSON/);
  const terminal = Object.assign(Readable.from([]), { isTTY: true });
  await expect(readJson('-', terminal)).rejects.toThrow(/Pipe/);
});
