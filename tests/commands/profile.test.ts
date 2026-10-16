import { describe, expect, it, vi } from 'vitest';
import { createProfileCommands } from '../../src/commands/profile.js';
import type { ProfileIO } from '../../src/commands/profile.js';
import type { ProfileScope, SavedProfile } from '../../src/core/profiles.js';
import { validateProfile } from '../../src/core/rules.js';
import { profile } from '../fixtures.js';

function fixture() {
  const saved: SavedProfile[] = [];
  const read = vi.fn<(file: string) => Promise<unknown>>(async () => profile);
  const edit = vi.fn(async (value: unknown): Promise<unknown> => value);
  const choose = vi.fn(async (choices: SavedProfile[]) => choices[0] as SavedProfile);
  const confirm = vi.fn(async () => true);
  const io: ProfileIO = {
    repoId: 'a'.repeat(16),
    interactive: true,
    read,
    edit,
    choose,
    confirm,
    store: {
      async list(scope) {
        return saved.filter((entry) => JSON.stringify(entry.scope) === JSON.stringify(scope));
      },
      async save(scope, value, id) {
        const entry = { scope, id: id ?? `pf_${saved.length}`, profile: validateProfile(value) };
        const index = saved.findIndex((item) => item.id === id);
        if (index < 0) saved.push(entry);
        else saved[index] = entry;
        return entry;
      },
      async remove(entry) {
        saved.splice(saved.indexOf(entry), 1);
      },
    },
  };
  const add = async (scope: ProfileScope, name = 'acme') =>
    io.store.save(scope, validateProfile({ ...profile, name }));
  return { io, saved, read, edit, choose, confirm, add, commands: createProfileCommands(io) };
}
describe('profile commands', () => {
  it('validates stdin imports, stores them and lists them', async () => {
    const { commands, read, saved } = fixture();
    const entry = await commands.import('-', { scope: 'global' });
    expect(read).toHaveBeenCalledWith('-');
    expect(saved).toEqual([entry]);
    expect(await commands.list({})).toEqual([entry]);
    expect(await commands.show('acme', {})).toEqual(profile);
  });
  it('does not save invalid imported rules', async () => {
    const { commands, read, saved } = fixture();
    read.mockResolvedValue({
      ...profile,
      rules: [{ id: 'bad', type: 'regex', match: '[', replace: 'x' }],
    });
    await expect(commands.import('-', {})).rejects.toThrow(/bad/);
    expect(saved).toEqual([]);
  });
  it('fails under --yes when global and repo names collide', async () => {
    const { commands, add, choose } = fixture();
    await add({ kind: 'global' });
    await add({ kind: 'repo', repoId: 'a'.repeat(16) });
    await expect(commands.show('acme', { yes: true })).rejects.toThrow(/--global.*--repo/);
    expect(choose).not.toHaveBeenCalled();
    expect(await commands.show('acme', { scope: 'global', yes: true })).toEqual(profile);
  });
  it('asks which profile when names collide interactively', async () => {
    const { commands, add, choose } = fixture();
    await add({ kind: 'global' });
    await add({ kind: 'repo', repoId: 'a'.repeat(16) });
    await commands.show('acme', {});
    expect(choose).toHaveBeenCalledOnce();
  });
  it('does not prompt when stdin is not a terminal', async () => {
    const { commands, add, io, choose } = fixture();
    io.interactive = false;
    await add({ kind: 'global' });
    await add({ kind: 'repo', repoId: 'a'.repeat(16) });
    await expect(commands.show('acme', {})).rejects.toThrow(/--global.*--repo/);
    expect(choose).not.toHaveBeenCalled();
  });
  it('creates and edits through an adapter and keeps unknown fields', async () => {
    const { commands, edit, saved } = fixture();
    edit.mockResolvedValue({ ...profile, future: { enabled: true } });
    const created = await commands.create('acme', { scope: 'global' });
    edit.mockResolvedValue({ ...profile, name: 'changed', future: { enabled: true } });
    const updated = await commands.edit('acme', { scope: 'global' });
    expect(updated.id).toBe(created.id);
    expect(updated.profile.name).toBe('changed');
    expect(updated.profile.future).toEqual({ enabled: true });
    expect(saved).toEqual([updated]);
  });
  it('preserves the previous profile on an invalid edit', async () => {
    const { commands, add, saved, edit } = fixture();
    const original = await add({ kind: 'global' });
    edit.mockResolvedValue({
      ...profile,
      rules: [{ id: 'bad', type: 'regex', match: '[', replace: 'x' }],
    });
    await expect(commands.edit('acme', {})).rejects.toThrow(/bad/);
    expect(saved).toEqual([original]);
  });
  it('confirms deletions and supports --yes without prompting', async () => {
    const { commands, add, saved, confirm } = fixture();
    await add({ kind: 'global' });
    confirm.mockResolvedValue(false);
    expect(await commands.remove('acme', {})).toBeUndefined();
    expect(saved).toHaveLength(1);
    await commands.remove('acme', { yes: true });
    expect(saved).toEqual([]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it('checks profiles using the same merge validation as a run', async () => {
    const { commands, add } = fixture();
    await add({ kind: 'global' });
    expect(await commands.check(['acme'], {})).toEqual({ profiles: 1, rules: 1 });
    await expect(commands.check(['acme', 'acme'], {})).rejects.toThrow(/twice/);
  });
  it('requires --global outside a repo for imports and --repo needs a repo', async () => {
    const { commands, io } = fixture();
    io.repoId = undefined;
    await expect(commands.import('-', {})).rejects.toThrow(/--global/);
    await expect(commands.list({ scope: 'repo' })).rejects.toThrow(/repository/);
    expect(await commands.import('-', { scope: 'global' })).toHaveProperty('scope', {
      kind: 'global',
    });
  });
});
