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

it('adds cloak folders to Orca with literal absolute paths and uses the Linux IDE command', async () => {
  const calls: string[][] = [];
  const desktop = createDesktop(
    'linux',
    async (command, args) => {
      calls.push([command, ...args]);
    },
    async (name) => `/installed/${name}`,
    'orca-ide',
  );
  const path = await canonicalPath(join(tmpdir(), 'cloak with $literal; characters'));
  expect(await desktop.availability()).toMatchObject({
    orca: { label: 'Add to Orca', available: true },
  });
  await desktop.open(path, 'orca');
  expect(calls).toEqual([['/installed/orca-ide', 'repo', 'add', '--path', path, '--json']]);
});

it('distinguishes missing Orca from installed but failing commands', async () => {
  const path = await canonicalPath(join(tmpdir(), 'orca cloak'));
  const missing = createDesktop(
    'darwin',
    async () => {},
    async () => undefined,
    'orca',
  );
  expect(await missing.availability()).toMatchObject({ orca: { available: false } });
  await expect(missing.open(path, 'orca')).rejects.toThrow(/Orca CLI.*not installed/);
  const failing = createDesktop(
    'darwin',
    async () => {
      throw new Error('Offline');
    },
    async () => '/bin/orca',
    'orca',
  );
  await expect(failing.open(path, 'orca')).rejects.toThrow(/Open Orca/);
});
