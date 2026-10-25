import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { canonicalPath } from './locations.js';

export type DesktopTarget = 'folder' | 'vscode' | 'zed' | 'orca';
const execute = promisify(execFile);

async function locate(name: string): Promise<string | undefined> {
  const candidates = isAbsolute(name)
    ? [name]
    : name.endsWith('.app')
      ? [join('/Applications', name), join(homedir(), 'Applications', name)]
      : (process.env.PATH ?? '').split(delimiter).map((directory) => join(directory, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, name.endsWith('.app') ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {
      /* Try the next installation location. */
    }
  }
  return undefined;
}

export function createDesktop(
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: string[]) => Promise<void> = async (command, args) => {
    await execute(command, args, { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
  },
  find: (name: string) => Promise<string | undefined> = locate,
  orcaCommand = process.env.ORCA_CLI_COMMAND ??
    (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : platform === 'linux' ? 'orca-ide' : 'orca'),
) {
  async function application(target: DesktopTarget) {
    if (target === 'orca') return find(orcaCommand);
    if (target === 'folder')
      return platform === 'darwin'
        ? '/usr/bin/open'
        : platform === 'win32'
          ? 'explorer.exe'
          : find('xdg-open');
    if (platform === 'darwin') {
      const app = await find(target === 'vscode' ? 'Visual Studio Code.app' : 'Zed.app');
      if (app) return app;
    }
    return find(
      platform === 'win32'
        ? target === 'vscode'
          ? 'Code.exe'
          : 'zed.exe'
        : target === 'vscode'
          ? 'code'
          : 'zed',
    );
  }
  const labels = {
    folder:
      platform === 'darwin'
        ? 'Reveal in Finder'
        : platform === 'win32'
          ? 'Reveal in Explorer'
          : 'Open in Files',
    vscode: 'Open in VS Code',
    zed: 'Open in Zed',
    orca: 'Add to Orca',
  };
  return {
    async availability() {
      return Object.fromEntries(
        await Promise.all(
          (['folder', 'vscode', 'zed', 'orca'] as const).map(async (target) => [
            target,
            {
              label: labels[target],
              available: !!(await application(target)),
              ...(target === 'orca'
                ? { unavailableReason: 'Install Orca and enable its CLI first.' }
                : {}),
            },
          ]),
        ),
      );
    },
    async open(path: string, target: DesktopTarget) {
      if (!isAbsolute(path) || (await canonicalPath(path)) !== path)
        throw new Error('Folder changed; refresh the dashboard before opening it');
      const app = await application(target);
      if (!app && target === 'orca')
        throw new Error(
          'Orca CLI is not installed or not available on PATH. Install Orca and enable its CLI.',
        );
      if (!app)
        throw new Error(
          `${labels[target]} is unavailable. Install the application or its command-line launcher first.`,
        );
      try {
        if (target === 'orca') await run(app, ['repo', 'add', '--path', path, '--json']);
        else if (platform === 'darwin' && target === 'folder')
          await run('/usr/bin/open', ['-R', path]);
        else if (platform === 'darwin' && app.endsWith('.app'))
          await run('/usr/bin/open', ['-a', app, path]);
        else await run(app, [path]);
      } catch (error) {
        if (target === 'orca') {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
            throw new Error(
              'Orca CLI is not installed or no longer available. Install Orca and enable its CLI.',
              { cause: error },
            );
          throw new Error(
            'Could not add this folder to Orca. Open Orca and check that its CLI can run.',
            { cause: error },
          );
        }
        throw new Error(
          `Could not ${labels[target].toLowerCase()}. Check that the application is installed and can open folders.`,
          { cause: error },
        );
      }
      return { opened: true };
    },
  };
}
