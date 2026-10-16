import { describe, expect, it, vi } from 'vitest';
import { runPull } from '../../src/commands/pull.js';
import type { PullIO } from '../../src/commands/pull.js';
import type { PullSetup } from '../../src/commands/pull-setup.js';
import { validateProfile } from '../../src/core/rules.js';

function fixture() {
  const setup: PullSetup = {
    repo: { repoId: 'a'.repeat(16), path: '/source', branch: 'main', commit: 'b'.repeat(40) },
    destination: '/workspace',
    previous: undefined,
    workspaceId: 'ws_test',
    profiles: [
      {
        id: 'pf_test',
        scope: { kind: 'global' },
        profile: validateProfile({
          kind: 'profile',
          schemaVersion: 1,
          name: 'client',
          rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
        }),
      },
    ],
    paths: ['Acme.ts'],
    config: { kind: 'config', schemaVersion: 1 },
    saveConfig: false,
    selection: { files: 1, commits: 0, working: false, extra: 0 },
  };
  const save = vi.fn<PullIO['save']>(async () => {});
  const confirmProfiles = vi.fn(async () => true);
  const confirmPull = vi.fn(async () => true);
  const readWorkspace = vi.fn<PullIO['readWorkspace']>(async () => ({ files: {}, paths: [] }));
  const io: PullIO = {
    save,
    confirmProfiles,
    confirmPull,
    readWorkspace,
    readSource: async () => ({
      files: [
        {
          path: 'Acme.ts',
          bytes: Buffer.from('class Acme {}'),
          text: 'class Acme {}',
          binary: false,
          executable: false,
        },
      ],
      warnings: [],
    }),
    now: () => '2026-10-16T10:00:00Z',
    newId: () => 'pull-id',
  };
  return { setup, io, save, confirmProfiles, confirmPull, readWorkspace };
}
describe('pull command with fake adapters', () => {
  it('dry-run reads and plans without confirmations or writes', async () => {
    const { setup, io, save, confirmProfiles, confirmPull } = fixture();
    expect((await runPull(setup, { dryRun: true }, io, '2.0.0')).status).toBe('dry-run');
    expect(save).not.toHaveBeenCalled();
    expect(confirmProfiles).not.toHaveBeenCalled();
    expect(confirmPull).not.toHaveBeenCalled();
  });
  it('does not write when confirmation is declined', async () => {
    const { setup, io, save, confirmPull } = fixture();
    confirmPull.mockResolvedValue(false);
    expect((await runPull(setup, {}, io, '2.0.0')).status).toBe('cancelled');
    expect(save).not.toHaveBeenCalled();
  });
  it('shows changed profile rules and asks before refreshing', async () => {
    const { setup, io, save, readWorkspace, confirmProfiles } = fixture();
    const first = await runPull(setup, { dryRun: true }, io, '2.0.0');
    setup.previous = {
      plain: first.plan.plain,
      data: first.plan.data,
      bytes: Buffer.from('sealed manifest'),
    };
    readWorkspace.mockResolvedValue({
      files: Object.fromEntries(first.plan.writes.map((file) => [file.path, file.bytes])),
      paths: first.plan.writes.map((file) => file.path),
    });
    const profile = setup.profiles[0];
    if (profile)
      profile.profile.rules = [
        { id: 'company', type: 'literal', match: 'Acme', replace: 'Contoso' },
      ];
    confirmProfiles.mockResolvedValue(false);
    const next = await runPull(setup, {}, io, '2.0.0');
    expect(next.plan.profileChanges).toContain('client');
    expect(next.plan.data.rules).toEqual(
      expect.arrayContaining([expect.objectContaining({ replace: 'Contoso' })]),
    );
    expect(confirmProfiles).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });
});
