import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runGit } from '../../src/adapters/git.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { createStore } from '../../src/adapters/store.js';

const prompts = vi.hoisted(() => ({ input: vi.fn() }));
vi.mock('@inquirer/prompts', () => ({
  ...prompts,
  checkbox: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  );
});
async function temp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak services ')));
  roots.push(root);
  return root;
}

it('prefills the workspaces root with the launch directory outside a repository', async () => {
  const root = await temp();
  const services = createSyncServices(root, createStore(join(root, 'store')));
  prompts.input.mockImplementationOnce(async (config: { default: string; prefill: string }) => {
    expect(config.default).toBe(root);
    expect(config.prefill).toBe('editable');
    return 'cloak';
  });
  // Relative answers resolve from where repo-cloak was started.
  expect(await services.workspacesRoot()).toBe(join(root, 'cloak'));
});

it('suggests the folder holding the repository when started inside one', async () => {
  const root = await temp();
  const repo = join(root, 'source');
  await mkdir(join(repo, 'src'), { recursive: true });
  await runGit(repo, ['init']);
  const services = createSyncServices(join(repo, 'src'), createStore(join(root, 'store')));
  prompts.input.mockImplementationOnce(async (config: { default: string }) => {
    expect(config.default).toBe(root);
    return ` ${config.default} `;
  });
  expect(await services.workspacesRoot()).toBe(root);
});
