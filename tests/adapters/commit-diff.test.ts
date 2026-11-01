import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCommitDiff } from '../../src/adapters/commit-diff.js';
import type { SourceFile } from '../../src/core/pull.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const directory = await mkdtemp(join(tmpdir(), 'cloak diff test '));
  roots.push(directory);
  return directory;
}
function textFile(path: string, text: string): SourceFile {
  return { path, bytes: Buffer.from(text), binary: false, executable: false };
}

it('exports a small anonymized patch when both schema versions exceed 1 MiB', async () => {
  const path = 'Acme/schema.graphql';
  const context = Array.from(
    { length: 30_000 },
    (_, i) => `  field${i}: String # schema field\n`,
  ).join('');
  const before = `type Acme {\n${context}  previous: String\n}\n`;
  const after = `type Acme {\n${context}  updated: Acme\n}\n`;
  expect(Buffer.byteLength(before)).toBeGreaterThan(1024 * 1024);
  expect(Buffer.byteLength(after)).toBeGreaterThan(1024 * 1024);
  const result = await createCommitDiff({
    root: await root(),
    before: [textFile(path, before)],
    after: [textFile(path, after)],
    paths: [path],
    rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
    ledger: [],
  });
  expect(Buffer.byteLength(result.patch)).toBeLessThan(1024);
  expect(result.patch).toContain(
    'diff --git a/Northwind/schema.graphql b/Northwind/schema.graphql',
  );
  expect(result.patch).toContain('-  previous: String');
  expect(result.patch).toContain('+  updated: Northwind');
  expect(result.patch).not.toContain('Acme');
  expect(result.files).toMatchObject([
    { path: 'Northwind/schema.graphql', added: 1, removed: 1, binary: false },
  ]);
});

it.each([1, 2])('still limits the actual combined patch for %i selected files', async (count) => {
  const paths = Array.from({ length: count }, (_, i) => `schema-${i}.graphql`);
  const text = 'field: String\n'.repeat(Math.ceil((1024 * 1024) / (count * 14)) + 20);
  await expect(
    createCommitDiff({
      root: await root(),
      before: [],
      after: paths.map((path) => textFile(path, text)),
      paths,
      rules: [],
      ledger: [],
    }),
  ).rejects.toThrow('1 MiB anonymized diff limit');
});
