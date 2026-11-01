import { describe, expect, it, vi } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { createProgram } from '../src/program.js';

describe('dashboard launcher', () => {
  it('keeps the package name and version', () => {
    expect(createProgram().name()).toBe('repo-cloak');
    expect(createProgram().version()).toBe(pkg.version);
  });
  it.each([[], ['ui']])('opens the dashboard without terminal prompts for %j', async (...args) => {
    const launch = vi.fn(async () => {});
    await createProgram(launch).parseAsync(args.flat(), { from: 'user' });
    expect(launch).toHaveBeenCalledWith(expect.any(Function), { open: true });
  });
  it('passes launcher options without requiring a TTY', async () => {
    const launch = vi.fn(async () => {});
    await createProgram(launch).parseAsync(['--port', '4321', '--no-open'], { from: 'user' });
    expect(launch).toHaveBeenCalledWith(expect.any(Function), { port: 4321, open: false });
  });
  it.each([
    ['ui', '--port', '4321', '--no-open'],
    ['--port', '4321', '--no-open', 'ui'],
  ])('accepts options around the ui alias: %j', async (...args) => {
    const launch = vi.fn(async () => {});
    await createProgram(launch).parseAsync(args.flat(), { from: 'user' });
    expect(launch).toHaveBeenCalledWith(expect.any(Function), { port: 4321, open: false });
  });
  it.each([['--next-ui'], ['ui', '--next-ui']])(
    'passes the next UI flag for %j',
    async (...args) => {
      const launch = vi.fn(async () => {});
      await createProgram(launch).parseAsync(args.flat(), { from: 'user' });
      expect(launch).toHaveBeenCalledWith(expect.any(Function), { open: true, nextUi: true });
    },
  );
  it.each(['0', '-1', '65536', 'bad'])('rejects invalid port %s', async (port) => {
    const launch = vi.fn(async () => {});
    await expect(
      createProgram(launch)
        .exitOverride()
        .configureOutput({ writeErr: () => {} })
        .parseAsync(['--port', port], { from: 'user' }),
    ).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
  it.each(['push', 'pull', 'profile', 'status', 'schema', 'workspaces'])(
    'rejects removed command %s without launching',
    async (command) => {
      const launch = vi.fn(async () => {});
      await expect(
        createProgram(launch)
          .exitOverride()
          .configureOutput({ writeErr: () => {} })
          .parseAsync([command], { from: 'user' }),
      ).rejects.toThrow();
      expect(launch).not.toHaveBeenCalled();
    },
  );
});
