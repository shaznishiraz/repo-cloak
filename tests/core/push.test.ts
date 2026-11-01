import { describe, expect, it } from 'vitest';
import { planPull } from '../../src/core/pull.js';
import type { SourceFile } from '../../src/core/pull.js';
import { planPush } from '../../src/core/push.js';
import type { Snapshot } from '../../src/core/manifest.js';
import { validateProfile } from '../../src/core/rules.js';

function file(path: string, text: string): SourceFile {
  return { path, text, bytes: Buffer.from(text), binary: false, executable: false };
}
function snapshotProfiles() {
  return [
    {
      id: 'pf_test',
      scope: { kind: 'global' as const },
      profile: validateProfile({
        kind: 'profile',
        schemaVersion: 1,
        name: 'acme',
        rules: [
          { id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' },
          { id: 'key', type: 'secret', detector: 'github-token' },
        ],
      }),
    },
  ];
}
function snapshot(): Snapshot {
  return planPull({
    repo: { repoId: '0123456789abcdef', path: '/source', branch: 'main', commit: null },
    workspaceId: 'test',
    pullId: 'p_test',
    at: '2026-10-16T00:00:00Z',
    version: '2.0.0',
    profiles: snapshotProfiles(),
    files: [file('Acme.txt', 'Acme')],
    workspace: {},
    selection: { files: 1, commits: 0, working: false, extra: 0 },
  });
}
it('plans restored names and contents without mutating its snapshot', () => {
  const previous = snapshot();
  const before = JSON.stringify(previous);
  const plan = planPush(
    previous,
    [file('Northwind.txt', 'Northwind changed'), file('NorthwindClient.txt', 'NorthwindClient')],
    [file('Acme.txt', 'Acme')],
  );
  expect(plan.writes.map((write) => [write.path, Buffer.from(write.bytes).toString()])).toEqual([
    ['Acme.txt', 'Acme changed'],
    ['AcmeClient.txt', 'AcmeClient'],
  ]);
  expect(JSON.stringify(previous)).toBe(before);
});
it('copies binary bytes without trying to interpret anonymized words', () => {
  const previous = snapshot();
  const bytes = Buffer.from([0, 255, 1]);
  const plan = planPush(
    previous,
    [{ path: 'Northwind.bin', bytes, binary: true, executable: false }],
    [file('Acme.txt', 'Acme')],
  );
  expect(plan.writes[0]?.path).toBe('Acme.bin');
  expect(plan.writes[0]?.bytes).toEqual(bytes);
  expect(plan.deletes).toEqual(['Acme.txt']);
});
it('rejects contradictory conflict flags and unknown secret placeholders', () => {
  const previous = snapshot();
  expect(() => planPush(previous, [], [], { force: true, skipConflicts: true })).toThrow(
    'cannot be combined',
  );
  expect(() =>
    planPush(
      previous,
      [file('Northwind.txt', 'REDACTED_GITHUB_TOKEN_999')],
      [file('Acme.txt', 'Acme')],
    ),
  ).toThrow(/placeholder/i);
});
it('leaves conflicted baselines intact when skipping a source conflict', () => {
  const previous = snapshot();
  const plan = planPush(
    previous,
    [file('Northwind.txt', 'Northwind changed')],
    [file('Acme.txt', 'source changed')],
    { skipConflicts: true },
  );
  expect(plan.conflicts).toEqual(['Northwind.txt']);
  expect(plan.writes).toEqual([]);
  expect(plan.plain.files).toEqual(previous.plain.files);
  expect(plan.data.files).toEqual(previous.data.files);
});

it('restores unchanged tracked files into a new target when its base differs', () => {
  const previous = snapshot();
  const workspace = [file('Northwind.txt', 'Northwind')];
  const source = [file('Acme.txt', 'older base')];
  expect(planPush(previous, workspace, source).writes).toEqual([]);
  expect(
    planPush(previous, workspace, []).writes.map((write) => [
      write.path,
      Buffer.from(write.bytes).toString(),
    ]),
  ).toEqual([['Acme.txt', 'Acme']]);
  const plan = planPush(previous, workspace, source, { fullSnapshot: true });
  expect(plan.writes.map((write) => [write.path, Buffer.from(write.bytes).toString()])).toEqual([
    ['Acme.txt', 'Acme'],
  ]);
});
it('still protects unrelated base files from new agent files when restoring a full snapshot', () => {
  const previous = snapshot();
  expect(() =>
    planPush(
      previous,
      [file('Northwind.txt', 'Northwind'), file('new.txt', 'agent')],
      [file('Acme.txt', 'Acme'), file('new.txt', 'base')],
      { fullSnapshot: true },
    ),
  ).toThrow(/new.txt/);
});

describe('only', () => {
  function pair() {
    const pulled = planPull({
      repo: { repoId: '0123456789abcdef', path: '/source', branch: 'main', commit: null },
      workspaceId: 'test',
      pullId: 'p_test',
      at: '2026-10-16T00:00:00Z',
      version: '2.0.0',
      profiles: snapshotProfiles(),
      files: [file('Acme.txt', 'Acme'), file('b.txt', 'b'), file('gone.txt', 'gone')],
      workspace: {},
      selection: { files: 3, commits: 0, working: false, extra: 0 },
    });
    const source = [file('Acme.txt', 'Acme'), file('b.txt', 'b'), file('gone.txt', 'gone')];
    const workspace = [
      file('Northwind.txt', 'Northwind edit'),
      file('b.txt', 'b edit'),
      file('new.txt', 'new'),
    ];
    return { pulled, source, workspace };
  }

  it('writes only the selected paths and keeps old baselines for the rest', () => {
    const { pulled, source, workspace } = pair();
    const plan = planPush(pulled, workspace, source, { only: new Set(['b.txt']) });
    expect(plan.writes.map((write) => write.path)).toEqual(['b.txt']);
    expect(plan.deletes).toEqual([]);
    expect(plan.plain.files['Northwind.txt']).toEqual(pulled.plain.files['Northwind.txt']);
    expect(plan.data.files['Northwind.txt']).toEqual(pulled.data.files['Northwind.txt']);
    // An unselected deletion stays tracked, an unselected new file stays untracked.
    expect(plan.plain.files['gone.txt']).toEqual(pulled.plain.files['gone.txt']);
    expect(plan.plain.files['new.txt']).toBeUndefined();
    expect(plan.plain.files['b.txt']).not.toEqual(pulled.plain.files['b.txt']);
    expect(plan.data.ledger).toEqual(pulled.data.ledger);
  });

  it('applies a selected deletion, and an empty selection changes nothing', () => {
    const { pulled, source, workspace } = pair();
    const deleted = planPush(pulled, workspace, source, { only: new Set(['gone.txt']) });
    expect(deleted.deletes).toEqual(['gone.txt']);
    expect(deleted.writes).toEqual([]);
    expect(deleted.plain.files['gone.txt']).toBeUndefined();
    const none = planPush(pulled, workspace, source, { only: new Set() });
    expect(none.writes).toEqual([]);
    expect(none.deletes).toEqual([]);
    expect(none.plain.files).toEqual(pulled.plain.files);
  });

  it('does not report or block on a conflict outside the selection', () => {
    const { pulled, source, workspace } = pair();
    const moved = source.map((item) => (item.path === 'Acme.txt' ? file('Acme.txt', 'up') : item));
    const plan = planPush(pulled, workspace, moved, { only: new Set(['b.txt']) });
    expect(plan.conflicts).toEqual([]);
    expect(() => planPush(pulled, workspace, moved, { only: new Set(['Northwind.txt']) })).toThrow(
      /Source files changed/,
    );
  });

  it('does not recreate an unselected file that the source removed', () => {
    const { pulled, workspace } = pair();
    const unchanged = [file('Northwind.txt', 'Northwind'), ...workspace.slice(1)];
    const plan = planPush(pulled, unchanged, [file('b.txt', 'b')], { only: new Set(['b.txt']) });
    expect(plan.writes.map((write) => write.path)).toEqual(['b.txt']);
  });

  it('still writes files unchanged in the cloak into a new worktree', () => {
    const { pulled } = pair();
    const workspace = [
      file('Northwind.txt', 'Northwind edit'),
      file('b.txt', 'b'),
      file('gone.txt', 'gone'),
    ];
    const plan = planPush(pulled, workspace, [], {
      fullSnapshot: true,
      only: new Set(['gone.txt']),
    });
    // Edited and unselected: left out. Unchanged: part of the snapshot.
    expect(plan.writes.map((write) => write.path).sort()).toEqual(['b.txt', 'gone.txt']);
  });
});
