import { expect, it } from 'vitest';
import { hashBytes } from '../../src/core/hash.js';
import { workspaceStatus } from '../../src/core/status.js';

it('reports added, modified and deleted paths while skipping unchanged bytes', () => {
  const bytes = Buffer.from('unchanged');
  const baseline = Object.fromEntries(
    ['same.txt', 'edited.txt', 'removed.txt'].map((path) => [path, { hash: hashBytes(bytes) }]),
  );
  expect(
    workspaceStatus(baseline, {
      'same.txt': bytes,
      'edited.txt': Buffer.from('changed'),
      'new.txt': Buffer.from([0, 255]),
    }),
  ).toEqual({ added: ['new.txt'], modified: ['edited.txt'], deleted: ['removed.txt'] });
});
