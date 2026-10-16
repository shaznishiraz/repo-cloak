import { expect, it } from 'vitest';
import { planPull } from '../../src/core/pull.js';
import type { SourceFile } from '../../src/core/pull.js';
import { planPush } from '../../src/core/push.js';
import type { Snapshot } from '../../src/core/manifest.js';
import { validateProfile } from '../../src/core/rules.js';

function file(path: string, text: string): SourceFile {
  return { path, text, bytes: Buffer.from(text), binary: false, executable: false };
}
function snapshot(): Snapshot {
  return planPull({
    repo: { repoId: '0123456789abcdef', path: '/source', branch: 'main', commit: null },
    workspaceId: 'test',
    pullId: 'p_test',
    at: '2026-10-16T00:00:00Z',
    version: '2.0.0',
    profiles: [
      {
        id: 'pf_test',
        scope: { kind: 'global' },
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
    ],
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
