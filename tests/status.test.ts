import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createProgram } from '../src/program.js';
import { createStatusIO } from '../src/adapters/status.js';
import { hashBytes } from '../src/core/hash.js';

it('reports changes from a nested directory without a key or changing the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak-status-'));
  try {
    await mkdir(join(root, '.repo-cloak'));
    await mkdir(join(root, 'nested'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'ignored');
    const bytes = Buffer.from('old');
    const files = Object.fromEntries(
      ['same', 'edited', 'deleted'].map((path) => [
        path,
        {
          hash: hashBytes(bytes),
          size: bytes.length,
          binary: false,
        },
      ]),
    );
    const manifest = JSON.stringify({
      kind: 'manifest',
      schemaVersion: 2,
      tool: { name: 'repo-cloak', version: '2.0.0' },
      workspaceId: 'test',
      source: { repoId: '0123456789abcdef' },
      files,
      pulls: [],
      sealed: { alg: 'A256GCM', keyId: 'unavailable', nonce: 'unavailable', data: 'unavailable' },
    });
    await writeFile(join(root, '.repo-cloak', 'manifest.json'), manifest);
    await writeFile(join(root, 'same'), bytes);
    await writeFile(join(root, 'edited'), 'new');
    await writeFile(join(root, 'nested', 'new.bin'), Buffer.from([0, 255]));
    let output = '';
    const program = createProgram(undefined, undefined, async () =>
      createStatusIO(join(root, 'nested')),
    ).configureOutput({
      writeOut: (text) => {
        output += text;
      },
    });
    await program.parseAsync(['status', '--json'], { from: 'user' });
    expect(JSON.parse(output)).toEqual({
      workspaceId: 'test',
      added: ['nested/new.bin'],
      modified: ['edited'],
      deleted: ['deleted'],
    });
    expect(await readFile(join(root, '.repo-cloak', 'manifest.json'), 'utf8')).toBe(manifest);
    expect(await readdir(join(root, '.repo-cloak'))).toEqual(['manifest.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('explains that status requires a workspace', async () => {
  const { runStatus } = await import('../src/commands/status.js');
  await expect(
    runStatus({
      cwd: '/',
      findWorkspace: async () => undefined,
      readManifest: async () => {
        throw new Error('unexpected read');
      },
      readFiles: async () => {
        throw new Error('unexpected read');
      },
    }),
  ).rejects.toThrow('inside a repo-cloak workspace');
});
