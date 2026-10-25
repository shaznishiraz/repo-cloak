import { expect, it } from 'vitest';
import { createDesktop } from '../../src/adapters/desktop.js';
import { canonicalPath } from '../../src/adapters/locations.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('opens Finder, VS Code and Zed using literal folder arguments and installed app bundles', async () => {
  const calls: { command: string; args: string[] }[] = [];
  const desktop = createDesktop(
    'darwin',
    async (command, args) => {
      calls.push({ command, args });
    },
    async (name) => (name.endsWith('.app') ? `/Applications/${name}` : undefined),
  );
  expect(await desktop.availability()).toMatchObject({
    folder: { available: true },
    vscode: { available: true },
    zed: { available: true },
  });
  const path = await canonicalPath(join(tmpdir(), 'a folder with $literal; chars'));
  for (const target of ['folder', 'vscode', 'zed'] as const) await desktop.open(path, target);
  expect(calls).toEqual([
    { command: '/usr/bin/open', args: ['-R', path] },
    { command: '/usr/bin/open', args: ['-a', '/Applications/Visual Studio Code.app', path] },
    { command: '/usr/bin/open', args: ['-a', '/Applications/Zed.app', path] },
  ]);
});

it('uses available Linux editor CLIs and reports missing editors without running commands', async () => {
  const calls: string[][] = [];
  const desktop = createDesktop(
    'linux',
    async (command, args) => {
      calls.push([command, ...args]);
    },
    async (name) => (name === 'zed' ? undefined : `/usr/bin/${name}`),
  );
  expect(await desktop.availability()).toMatchObject({
    zed: { available: false },
    vscode: { available: true },
  });
  const path = await canonicalPath(join(tmpdir(), 'desktop-work'));
  await expect(desktop.open(path, 'zed')).rejects.toThrow(/Install/);
  await desktop.open(path, 'vscode');
  await desktop.open(path, 'folder');
  expect(calls).toEqual([
    ['/usr/bin/code', path],
    ['/usr/bin/xdg-open', path],
  ]);
  await expect(desktop.open('relative/folder', 'vscode')).rejects.toThrow(/Folder changed/);
});
