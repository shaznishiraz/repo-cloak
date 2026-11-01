import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEnvironment, runCheckCommand } from '../../src/adapters/post-check.js';

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function folder() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak post check ')));
  roots.push(root);
  return root;
}

it('keeps only the allowlist in the environment', () => {
  const env = checkEnvironment({
    PATH: '/bin',
    HOME: '/h',
    GIT_DIR: '/secret/.git',
    REPO_CLOAK_TOKEN: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    NODE_OPTIONS: '--require evil',
  });
  expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
});

it('captures output and the exit code, in the given folder', async () => {
  const cwd = await folder();
  const passed = await runCheckCommand('pwd; echo err >&2', cwd, 10_000);
  expect(passed).toMatchObject({ state: 'passed', exitCode: 0, truncated: false });
  expect(passed.output).toContain(cwd);
  expect(passed.output).toContain('err');
  const failed = await runCheckCommand('echo broken; exit 3', cwd, 10_000);
  expect(failed).toMatchObject({ state: 'failed', exitCode: 3 });
  expect(failed.output).toContain('broken');
});

it('does not hand the command secrets from the environment, and closes stdin', async () => {
  vi.stubEnv('REPO_CLOAK_SESSION_TOKEN', 'the-session-token');
  vi.stubEnv('GIT_DIR', '/tmp/not-this');
  try {
    const result = await runCheckCommand('env; cat; echo stdin-closed', await folder(), 10_000);
    expect(result.output).not.toContain('the-session-token');
    expect(result.output).not.toContain('GIT_DIR');
    expect(result.output).toContain('PATH=');
    expect(result.output).toContain('stdin-closed');
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('on timeout', () => {
  it('stops the command and everything it started, keeping what it printed', async () => {
    const cwd = await folder();
    const marker = join(cwd, 'survived');
    const started = Date.now();
    const result = await runCheckCommand(
      `echo begun; (sleep 2; touch "${marker}") & sleep 30`,
      cwd,
      300,
    );
    expect(result.state).toBe('timed-out');
    expect(result.output).toContain('begun');
    expect(Date.now() - started).toBeLessThan(10_000);
    await new Promise((done) => setTimeout(done, 2_500));
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('escalates when the command ignores SIGTERM', async () => {
    const result = await runCheckCommand(`trap '' TERM; echo begun; sleep 30`, await folder(), 300);
    expect(result.state).toBe('timed-out');
    expect(result.output).toContain('begun');
  });
});

it('keeps the end of long output and marks it truncated', async () => {
  const cwd = await folder();
  await writeFile(join(cwd, 'big'), `${'x'.repeat(400 * 1024)}the end\n`);
  const result = await runCheckCommand('cat big', cwd, 10_000);
  expect(result.truncated).toBe(true);
  expect(result.output.length).toBeLessThanOrEqual(256 * 1024);
  expect(result.output).toContain('the end');
});

it('reports a folder it cannot start in', async () => {
  const result = await runCheckCommand('echo never', join(await folder(), 'missing'), 5_000);
  expect(result.state).toBe('failed');
  expect(result.exitCode).toBeNull();
});
