import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { writeAtomic } from '../../src/adapters/atomic.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
it('cleans up the temporary file after a failed replacement, leaving the destination intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak atomic '));
  roots.push(root);
  const destination = join(root, 'destination');
  await mkdir(destination);
  await writeAtomic(join(destination, 'existing.json'), 'original');
  await expect(writeAtomic(destination, 'replacement')).rejects.toThrow();
  expect(await readFile(join(destination, 'existing.json'), 'utf8')).toBe('original');
  expect(await readdir(root)).toEqual(['destination']);
});
