import { expect, it } from 'vitest';
import { groupInputSchema, groupSchema } from '../../src/core/groups.js';

const member = { repoId: 'a'.repeat(16), workspaceId: 'ws_backend', worktree: '/work/backend' };

it('allows a single initial member and trims names while rejecting ambiguous membership', () => {
  expect(groupInputSchema.parse({ name: ' Backend and frontend ', members: [member] }).name).toBe(
    'Backend and frontend',
  );
  for (const value of [
    { name: ' ', members: [member] },
    { name: 'App', members: [] },
    { name: 'App', members: [member, member] },
    { name: 'App', members: [{ ...member, repoId: '../other' }] },
    { name: 'App', members: [{ ...member, workspaceId: '' }] },
    { name: 'App', members: [member], unexpected: true },
  ])
    expect(groupInputSchema.safeParse(value).success).toBe(false);
  expect(
    groupSchema.safeParse({
      kind: 'group',
      schemaVersion: 1,
      id: '../outside',
      name: 'App',
      members: [member],
    }).success,
  ).toBe(false);
});
