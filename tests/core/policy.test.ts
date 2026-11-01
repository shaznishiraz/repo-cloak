import { expect, it } from 'vitest';
import { effectiveSecurity, policySchema } from '../../src/core/policy.js';
import type { LoadedPolicy } from '../../src/core/policy.js';

const active = (policy: Record<string, unknown>): LoadedPolicy => ({
  status: 'active',
  policy: policySchema.parse({ schemaVersion: 1, ...policy }),
  path: '/etc/repo-cloak/policy.json',
  signed: false,
  userWritable: false,
});

it('rejects unknown fields and invalid patterns', () => {
  expect(policySchema.safeParse({ schemaVersion: 1, extra: true }).success).toBe(false);
  expect(policySchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
  expect(policySchema.safeParse({ schemaVersion: 1, auditRetentionDays: 0 }).success).toBe(false);
  expect(policySchema.safeParse({ schemaVersion: 1, lockedExclusions: ['../x'] }).success).toBe(
    false,
  );
  expect(policySchema.safeParse({ schemaVersion: 1, lockedExclusions: ['*.pem'] }).success).toBe(
    true,
  );
});

it('uses user values and defaults when there is no policy', () => {
  expect(effectiveSecurity({}, { status: 'none' })).toEqual({
    lockedExclusions: [],
    auditRetentionDays: null,
    allowExclusionOverride: true,
    autoLockMinutes: null,
    locked: [],
  });
  expect(
    effectiveSecurity({ auditRetentionDays: 9, allowExclusionOverride: false }, { status: 'none' }),
  ).toMatchObject({ auditRetentionDays: 9, allowExclusionOverride: false, locked: [] });
});

it('lets policy values override user config and reports each as locked', () => {
  const result = effectiveSecurity(
    { auditRetentionDays: 9, allowExclusionOverride: true, autoLockMinutes: 60 },
    active({
      lockedExclusions: ['*.pem'],
      auditRetentionDays: 365,
      allowExclusionOverride: false,
      autoLockMinutes: 15,
    }),
  );
  expect(result).toEqual({
    lockedExclusions: ['*.pem'],
    auditRetentionDays: 365,
    allowExclusionOverride: false,
    autoLockMinutes: 15,
    locked: ['lockedExclusions', 'auditRetentionDays', 'allowExclusionOverride', 'autoLockMinutes'],
  });
});

it('only locks what the policy actually sets', () => {
  const result = effectiveSecurity({ autoLockMinutes: 60 }, active({ auditRetentionDays: 30 }));
  expect(result.locked).toEqual(['auditRetentionDays']);
  expect(result.autoLockMinutes).toBe(60);
});

it('fails closed on overrides when a policy exists but cannot be trusted', () => {
  const result = effectiveSecurity(
    { allowExclusionOverride: true },
    { status: 'invalid', path: '/x', message: 'bad signature' },
  );
  expect(result.allowExclusionOverride).toBe(false);
  expect(result.locked).toEqual(['allowExclusionOverride']);
});
