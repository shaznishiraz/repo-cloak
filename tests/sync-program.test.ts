import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createProgram } from '../src/program.js';
import { createSyncServices } from '../src/adapters/sync-services.js';
import { createStore } from '../src/adapters/store.js';
import { runGit } from '../src/adapters/git.js';
import { createSyncCommand } from '../src/commands/sync.js';
import { validateProfile } from '../src/core/rules.js';

it('routes push/pull flags through the real CLI parser and supports a first uncommitted repo', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak cli ')));
  try {
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    await runGit(source, ['init', '-b', 'main']);
    await writeFile(join(source, 'Acme.ts'), 'Acme');
    await writeFile(join(source, 'other.ts'), 'Acme');
    const services = createSyncServices(source, createStore(join(root, 'store')));
    await services.profiles.save(
      { kind: 'global' },
      validateProfile({
        kind: 'profile',
        schemaVersion: 1,
        name: 'client',
        rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
      }),
    );
    await services.store.saveConfig({ kind: 'config', schemaVersion: 1, initGit: false });
    const run = async (args: string[], cwd = source) => {
      let output = '';
      const program = createProgram(undefined, async () =>
        createSyncCommand({ ...services, cwd }, '2.0.0'),
      ).configureOutput({
        writeOut: (value) => {
          output += value;
        },
      });
      await program.parseAsync(args, { from: 'user' });
      return JSON.parse(output) as { status: string; writes: string[] };
    };
    const args = [
      'push',
      '--profile',
      'global:client',
      '--files',
      'Acme.ts',
      '--files',
      'other.ts',
      '--working',
      '--to',
      destination,
      '--yes',
      '--json',
    ];
    const preview = await run([...args, '--dry-run']);
    expect(preview.status).toBe('dry-run');
    expect(await readdir(root)).not.toContain('destination');
    const result = await run(args);
    expect(result.writes).toEqual(['Northwind.ts', 'other.ts']);
    expect(await readFile(join(destination, 'Northwind.ts'), 'utf8')).toBe('Northwind');
    const refreshed = await run(['pull', '--yes', '--json'], destination);
    expect(refreshed.status).toBe('written');
    await writeFile(join(destination, 'Northwind.ts'), 'class Northwind { edited = true }');
    const restored = await run(['push', '--yes', '--json'], destination);
    expect(restored.writes).toEqual(['Acme.ts']);
    expect(await readFile(join(source, 'Acme.ts'), 'utf8')).toBe('class Acme { edited = true }');
    await writeFile(join(destination, 'Northwind.ts'), 'class Northwind { forced = true }');
    await writeFile(join(source, 'Acme.ts'), 'source change');
    await run(['pull', '--from', destination, '--force', '--yes', '--json']);
    expect(await readFile(join(source, 'Acme.ts'), 'utf8')).toBe('class Acme { forced = true }');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
