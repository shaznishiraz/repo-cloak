import { z } from 'zod';
import { patternProblem } from './patterns.js';

const pattern = z
  .string()
  .min(1)
  .max(500)
  .superRefine((value, context) => {
    const problem = patternProblem(value);
    if (problem) context.addIssue({ code: 'custom', message: problem });
  });
export const policySchema = z.strictObject({
  schemaVersion: z.literal(1),
  lockedExclusions: z.array(pattern).max(500).optional(),
  auditRetentionDays: z.number().int().positive().optional(),
  allowExclusionOverride: z.boolean().optional(),
  autoLockMinutes: z.number().int().positive().optional(),
});
export type Policy = z.infer<typeof policySchema>;

export type LoadedPolicy =
  | { status: 'none' }
  | { status: 'active'; policy: Policy; path: string; signed: boolean; userWritable: boolean }
  | { status: 'invalid'; path: string; message: string };

export type UserSecurityConfig = {
  auditRetentionDays?: number | null | undefined;
  allowExclusionOverride?: boolean | undefined;
  autoLockMinutes?: number | null | undefined;
};
export type LockedSetting =
  'lockedExclusions' | 'auditRetentionDays' | 'allowExclusionOverride' | 'autoLockMinutes';
export type EffectiveSecurity = {
  lockedExclusions: string[];
  auditRetentionDays: number | null;
  allowExclusionOverride: boolean;
  autoLockMinutes: number | null;
  locked: LockedSetting[];
};

/**
 * Policy values beat user config and are reported as locked. A policy that exists but cannot
 * be trusted fails closed for the one permission it could be hiding: overriding exclusions.
 */
export function effectiveSecurity(
  config: UserSecurityConfig,
  loaded: LoadedPolicy,
): EffectiveSecurity {
  const policy: Partial<Policy> = loaded.status === 'active' ? loaded.policy : {};
  const invalid = loaded.status === 'invalid';
  const locked: LockedSetting[] = [];
  if (policy.lockedExclusions?.length) locked.push('lockedExclusions');
  if (policy.auditRetentionDays !== undefined) locked.push('auditRetentionDays');
  if (policy.allowExclusionOverride !== undefined || invalid) locked.push('allowExclusionOverride');
  if (policy.autoLockMinutes !== undefined) locked.push('autoLockMinutes');
  return {
    lockedExclusions: policy.lockedExclusions ?? [],
    auditRetentionDays: policy.auditRetentionDays ?? config.auditRetentionDays ?? null,
    allowExclusionOverride: invalid
      ? false
      : (policy.allowExclusionOverride ?? config.allowExclusionOverride ?? true),
    autoLockMinutes: policy.autoLockMinutes ?? config.autoLockMinutes ?? null,
    locked,
  };
}
