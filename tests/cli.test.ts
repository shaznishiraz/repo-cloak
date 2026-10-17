import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const entry = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('../src/program.js', () => ({ createProgram: () => ({ parseAsync: entry.parse }) }));
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  entry.parse.mockReset();
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

it.each([
  ['error', 1],
  ['conflict', 2],
  ['cancel', 130],
  ['non-error', 1],
] as const)('maps a %s to exit code %i without printing a stack trace', async (kind, code) => {
  const { ConflictError } = await import('../src/core/errors.js');
  const error =
    kind === 'conflict'
      ? new ConflictError('Cannot overwrite source')
      : kind === 'non-error'
        ? 'Unexpected failure'
        : new Error('Operation failed');
  if (kind === 'cancel' && error instanceof Error) error.name = 'ExitPromptError';
  entry.parse.mockRejectedValue(error);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await import('../src/cli.js');
  expect(entry.parse).toHaveBeenCalledWith(process.argv);
  expect(process.exitCode).toBe(code);
  if (kind === 'cancel') expect(stderr).not.toHaveBeenCalled();
  else
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      `error: ${error instanceof Error ? error.message : error}\n`,
    );
});
it('does not report an error when parsing and command execution succeed', async () => {
  entry.parse.mockResolvedValue(undefined);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  await import('../src/cli.js');
  expect(process.exitCode).toBeUndefined();
  expect(stderr).not.toHaveBeenCalled();
});
