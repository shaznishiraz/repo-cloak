import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expandPaths,
  filterPaths,
  readSourceFiles,
  readWorkspace,
} from '../../src/adapters/files.js';
import { validateProfile } from '../../src/core/rules.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cloak files '));
  roots.push(root);
  return root;
}
describe('file selection and reading', () => {
  it('expands directories without interpreting literal filename glob characters', async () => {
    const root = await fixture();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', '[file].ts'), 'text');
    expect(await expandPaths(root, root, ['src'])).toEqual(['src/[file].ts']);
    expect(await expandPaths(root, root, ['src/[file].ts'])).toEqual(['src/[file].ts']);
    await expect(expandPaths(root, root, ['../outside'])).rejects.toThrow(/outside/);
  });
  it('preserves BOM/CRLF and treats invalid UTF-8 or binary headers as binary', async () => {
    const root = await fixture();
    await writeFile(join(root, 'text.ts'), '\uFEFFclass Acme {}\r\n');
    await writeFile(join(root, 'bad.bin'), Buffer.from([65, 66, 0xff]));
    await writeFile(join(root, 'image.pdf'), '%PDF-1.7 fake contents');
    const result = await readSourceFiles(root, ['text.ts', 'bad.bin', 'image.pdf'], 2);
    expect(result.files[0]?.text).toBe('\uFEFFclass Acme {}\r\n');
    expect(result.files.slice(1).every((file) => file.binary)).toBe(true);
  });
  it('filters defaults but permits profile overrides and never includes metadata', () => {
    const profile = validateProfile({
      kind: 'profile',
      schemaVersion: 1,
      name: 'test',
      rules: [],
      include: ['package-lock.json', '.git/**'],
      exclude: ['src/generated/**'],
    });
    expect(
      filterPaths(
        [
          'src/app.ts',
          'package-lock.json',
          'node_modules/a.js',
          '.git/config',
          'src/generated/a.ts',
        ],
        [profile],
      ),
    ).toEqual(['src/app.ts', 'package-lock.json']);
  });
  it('skips nested repositories and external directory symlinks', async () => {
    const root = await fixture();
    const outside = await fixture();
    await writeFile(join(outside, 'secret.txt'), 'private');
    await symlink(
      outside,
      join(root, 'external'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', '.git'), 'gitdir: elsewhere');
    await writeFile(join(root, 'nested', 'file.ts'), 'nested');
    const result = await readSourceFiles(root, ['external/secret.txt', 'nested/file.ts'], 2);
    expect(result.files).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });
  it('refuses workspace symlink parents even when the target stays inside', async () => {
    const root = await fixture();
    await mkdir(join(root, 'real'));
    await writeFile(join(root, 'real', 'file.ts'), 'mine');
    await symlink(
      join(root, 'real'),
      join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(readWorkspace(root, ['alias/file.ts'], 2)).rejects.toThrow(/symlink/);
  });
});
