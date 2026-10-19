import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgram } from '../src/program.js';
import { createProfileCommands } from '../src/commands/profile.js';
import { readJson } from '../src/adapters/input.js';
import { createProfileStore } from '../src/adapters/profiles.js';
import { createStore } from '../src/adapters/store.js';
import { profile } from './fixtures.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((p) => rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cloak profile cli '));
  roots.push(root);
  const commands = createProfileCommands({
    store: createProfileStore(createStore(root)),
    repoId: 'a'.repeat(16),
    interactive: false,
    read: (file) => readJson(file, Readable.from([JSON.stringify(profile)])),
    async edit() {
      throw new Error('Unexpected editor');
    },
    async choose() {
      throw new Error('Unexpected choice');
    },
    async confirm() {
      throw new Error('Unexpected confirmation');
    },
  });
  async function run(args: string[]) {
    let output = '';
    const program = createProgram(async () => commands)
      .configureOutput({
        writeOut: (text) => {
          output += text;
        },
        writeErr: () => {},
      })
      .exitOverride();
    // Commander copies these settings when subcommands are created, so set each explicitly.
    for (const command of program.commands) {
      command.exitOverride().configureOutput({ writeErr: () => {} });
      for (const child of command.commands)
        child.exitOverride().configureOutput({ writeErr: () => {} });
    }
    await program.parseAsync(args, { from: 'user' });
    return output;
  }
  return { root, run };
}
describe('profile CLI', () => {
  it('imports stdin, lists, shows, exports, checks and deletes through the real encrypted store', async () => {
    const { root, run } = await fixture();
    const imported = JSON.parse(await run(['profile', 'import', '-', '--global', '--json'])) as {
      id: string;
    };
    expect(imported.id).toMatch(/^pf_/);
    const file = await readFile(join(root, 'profiles', `${imported.id}.json`), 'utf8');
    expect(file).not.toContain('Acme');
    expect(file).not.toContain('Northwind');
    const listed = JSON.parse(await run(['--json', 'profile', '--global', 'list'])) as unknown[];
    expect(listed).toEqual([{ id: imported.id, name: 'acme', scope: 'global', rules: 1 }]);
    expect(JSON.parse(await run(['profile', 'show', 'acme', '--global']))).toEqual(profile);
    expect(JSON.parse(await run(['profile', 'export', 'acme', '--global']))).toEqual(profile);
    expect(JSON.parse(await run(['profile', 'check', 'acme', '--global', '--json']))).toEqual({
      profiles: 1,
      rules: 1,
    });
    await run(['profile', 'delete', 'acme', '--global', '--yes']);
    expect(JSON.parse(await run(['profile', 'list', '--global', '--json']))).toEqual([]);
  });
  it('rejects conflicting scope flags before reading or saving profiles', async () => {
    const { root, run } = await fixture();
    await expect(run(['profile', 'import', '-', '--global', '--repo'])).rejects.toThrow(
      /cannot be used/,
    );
    expect(await readdir(root)).toEqual([]);
  });
});
