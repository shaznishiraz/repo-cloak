import { z } from 'zod';

export const groupIdSchema = z.uuid();
export const groupMemberSchema = z
  .object({
    repoId: z.string().regex(/^[a-f0-9]{16}$/),
    workspaceId: z.string().min(1).max(200),
    worktree: z.string().min(1),
  })
  .strict();
export const groupInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    members: z
      .array(groupMemberSchema)
      .min(1)
      .max(8)
      .refine(
        (members) => new Set(members.map((member) => member.repoId)).size === members.length,
        'Each repository may appear only once in a group',
      ),
  })
  .strict();
export const groupSchema = z.looseObject({
  ...groupInputSchema.shape,
  kind: z.literal('group'),
  schemaVersion: z.literal(1),
  id: groupIdSchema,
  folder: z.string().min(1).optional(),
});
export type RepositoryGroup = z.infer<typeof groupSchema>;
export type GroupMember = z.infer<typeof groupMemberSchema>;
