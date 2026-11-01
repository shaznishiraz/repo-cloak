import { z } from 'zod';
import { hashJson } from './hash.js';

export const genesisHash = `sha256-${'0'.repeat(64)}`;
export const maxAuditFiles = 5000;

const text = z.string().min(1).max(4096);
const hash = z.string().regex(/^sha256-[a-f0-9]{64}$/);
export const auditOps = [
  'create',
  'pull',
  'push',
  'delete',
  'agent-approve',
  'agent-deny',
  'settings',
  'key-rotate',
  'key-migrate',
  'audit-retention',
] as const;

/**
 * Strict by design: an event can only hold metadata. There is nowhere to put file contents,
 * and an unexpected field is an error rather than something quietly stored.
 */
export const auditInputSchema = z.strictObject({
  who: z.string().min(1).max(200),
  op: z.enum(auditOps),
  outcome: z.enum(['ok', 'failed']),
  workspace: z
    .strictObject({
      repoId: z.string().max(200).optional(),
      id: z.string().min(1).max(200),
      name: z.string().max(200).optional(),
    })
    .optional(),
  files: z.array(z.strictObject({ path: text, hash: hash.optional() })).max(maxAuditFiles),
  filesOmitted: z.number().int().positive().optional(),
  profiles: z.array(z.strictObject({ id: text, hash: z.string().min(1).max(200) })),
  keyId: z.string().max(100).nullable(),
  detail: z.string().max(500).optional(),
});
export type AuditInput = z.input<typeof auditInputSchema>;

export const auditEventSchema = auditInputSchema.extend({
  v: z.literal(1),
  seq: z.number().int().nonnegative(),
  at: z.iso.datetime({ offset: true }),
  prevHash: hash,
  hash,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

/** The position a chain continues from: its start, or after retention dropped older events. */
export type AuditLink = { seq: number; prevHash: string };
export const chainStart: AuditLink = { seq: 0, prevHash: genesisHash };

export function hashEvent(event: Omit<AuditEvent, 'hash'> & { hash?: string }): string {
  const { hash: _ignored, ...body } = event;
  void _ignored;
  return hashJson(body);
}

export function chainEvent(input: AuditInput, link: AuditLink, at: string): AuditEvent {
  const parsed = auditInputSchema.parse(input);
  const body = { ...parsed, v: 1 as const, seq: link.seq, at, prevHash: link.prevHash };
  return { ...body, hash: hashEvent(body) };
}
export function nextLink(event: Pick<AuditEvent, 'seq' | 'hash'>): AuditLink {
  return { seq: event.seq + 1, prevHash: event.hash };
}

export type AuditHead = { seq: number; hash: string };
export type VerifyResult =
  | { ok: true; count: number; headHash: string | null }
  | {
      ok: false;
      count: number;
      firstBroken: { index: number; seq: number | null; reason: string };
    };

/** Walks the chain and reports the first link that does not hold. */
export function verifyChain(
  events: readonly unknown[],
  options: { start?: AuditLink; head?: AuditHead | undefined } = {},
): VerifyResult {
  let link = options.start ?? chainStart;
  const broken = (index: number, seq: number | null, reason: string): VerifyResult => ({
    ok: false,
    count: events.length,
    firstBroken: { index, seq, reason },
  });
  let last: AuditEvent | undefined;
  let headSeen = false;
  for (const [index, value] of events.entries()) {
    const parsed = auditEventSchema.safeParse(value);
    if (!parsed.success) return broken(index, null, 'Event does not match the audit schema');
    const event = parsed.data;
    if (event.seq !== link.seq)
      return broken(index, event.seq, `Expected sequence ${link.seq}, found ${event.seq}`);
    if (event.prevHash !== link.prevHash)
      return broken(index, event.seq, 'Previous-hash link does not match');
    if (hashEvent(event) !== event.hash)
      return broken(index, event.seq, 'Event contents do not match their hash');
    if (options.head?.seq === event.seq) {
      if (options.head.hash !== event.hash)
        return broken(index, event.seq, 'Event does not match the recorded log head');
      headSeen = true;
    }
    link = nextLink(event);
    last = event;
  }
  // The head may lag one event after a crash, but the log may never be shorter than it.
  if (options.head && !headSeen && options.head.seq >= link.seq)
    return broken(events.length, options.head.seq, 'Log ends before its recorded head');
  return { ok: true, count: events.length, headHash: last?.hash ?? null };
}
