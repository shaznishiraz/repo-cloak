import { z } from 'zod';

export const MAX_AGENT_FILE_BYTES = 1024 * 1024;

export const agentId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const requestPath = z.string().min(1).max(1024);
export const requestItem = z.object({
  path: requestPath,
  original: z.string().min(1),
  state: z.enum(['pending', 'rejected', 'pulled', 'failed']),
  size: z.number().int().nonnegative(),
});
export const agentDocument = z.object({
  kind: z.literal('agent'),
  schemaVersion: z.literal(1),
  workspaceId: agentId,
  repoId: z.string().regex(/^[a-f0-9]{16}$/),
  path: z.string().min(1),
  worktree: z.string().min(1),
  enabled: z.boolean(),
  tokenHash: z.string(),
  requests: z
    .array(
      z.object({
        id: z.uuid(),
        clientRequestId: z.string().min(1).max(100),
        payloadHash: z.string(),
        reason: z.string().max(500),
        createdAt: z.string(),
        files: z.array(requestItem).max(20),
      }),
    )
    .max(50),
});
export type AgentDocument = z.infer<typeof agentDocument>;
export type AgentRequest = AgentDocument['requests'][number];
export type ProbeState = 'available' | 'unavailable' | 'not_allowed' | 'already_present';
