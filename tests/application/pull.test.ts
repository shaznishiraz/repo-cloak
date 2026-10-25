import { describe, expect, it, vi } from 'vitest';
import { preparePullRun } from '../../src/application/pull.js';
import type { PullIO } from '../../src/application/pull.js';
import type { PullSetup } from '../../src/application/pull-setup.js';
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
  const readWorkspace = vi.fn<PullIO['readWorkspace']>(async () => ({ files: {}, paths: [] }));
  const io: PullIO = {
    save,
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
  return { setup, io, save, readWorkspace };
}
describe('pull preparation with fake adapters', () => {
  it('keeps unrelated tracked file bytes out of a selective request read', async () => {
    const { setup, io, readWorkspace } = fixture();
    const first = await preparePullRun(setup, io, '2.0.0');
    setup.previous = {
      plain: first.plan.plain,
      data: first.plan.data,
      bytes: Buffer.from('baseline'),
    };
    setup.exactSelection = true;
    setup.paths = ['extra.ts'];
    io.readSource = async () => ({
      files: [
        {
          path: 'extra.ts',
          bytes: Buffer.from('export {};'),
          text: 'export {};',
          binary: false,
          executable: false,
        },
      ],
      warnings: [],
    });
    readWorkspace.mockClear();
    const next = await preparePullRun(setup, io, '2.0.0');
    expect(readWorkspace.mock.calls[0]?.[0]).not.toContain('Northwind.ts');
    expect(next.plan.plain.files).toHaveProperty('Northwind.ts');
    expect(next.plan.writes.map((file) => file.path)).toEqual(['extra.ts']);
  });
  it('plans without writing until explicitly applied', async () => {
    const { setup, io, save } = fixture();
    const prepared = await preparePullRun(setup, io, '2.0.0');
    expect(prepared.plan.writes.map((file) => file.path)).toEqual(['Northwind.ts']);
    expect(save).not.toHaveBeenCalled();
    await prepared.apply();
    expect(save).toHaveBeenCalledOnce();
  });
});
