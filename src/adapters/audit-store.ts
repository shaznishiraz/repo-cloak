import { randomUUID } from 'node:crypto';
import { mkdir, open as openFile, readFile, truncate } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import {
  auditEventSchema,
  chainEvent,
  chainStart,
  maxAuditFiles,
  nextLink,
  verifyChain,
} from '../core/audit.js';
import type { AuditEvent, AuditHead, AuditInput, AuditLink } from '../core/audit.js';
import { errorCode, writeAtomic } from './atomic.js';
import type { createStore } from './store.js';

type Store = Pick<ReturnType<typeof createStore>, 'root' | 'opener' | 'sealer' | 'keyStatus'>;
type Sealer = Awaited<ReturnType<Store['sealer']>>;
export type AuditRecord = Omit<AuditInput, 'who' | 'keyId' | 'files' | 'profiles'> & {
  files?: AuditInput['files'];
  profiles?: AuditInput['profiles'];
};
export type AuditVerification =
  | { ok: true; count: number; headHash: string | null }
  | { ok: false; count: number; firstBroken: { line: number; seq: number | null; reason: string } };
type ParsedLog = {
  start: AuditLink;
  events: { line: number; event: AuditEvent }[];
  firstBad?: { line: number; seq: number | null; reason: string };
  /** The byte length up to the last complete line. */
  complete: number;
  torn: boolean;
};

const dayMs = 86_400_000;
const eventAad = (seq: number) => ({ kind: 'audit-event', seq });
const anchorAad = { kind: 'audit-anchor' };
const headAad = { kind: 'audit-head' };

function who() {
  try {
    return userInfo().username || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Append-only sealed JSONL: one sealed event per line, flushed before the call returns. The
 * first line may be an anchor marking where the chain continues after retention. A separate
 * sealed head file lets verification see a log truncated at its end.
 *
 * Reseal, retention and appends hold one cross-process lock. Failing to record never fails the
 * operation being audited: the work has already happened, so the failure is reported instead.
 */
export function createAuditStore(
  store: Store,
  options: { retentionDays?: () => Promise<number | null>; now?: () => Date } = {},
) {
  const directory = join(store.root, 'audit');
  const logPath = join(directory, 'log.jsonl');
  const headPath = join(directory, 'head.json');
  const now = options.now ?? (() => new Date());
  let failures = 0;
  let lastPruned = 0;

  async function withLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lock(directory, {
      realpath: false,
      lockfilePath: join(directory, 'log.lock'),
      stale: 10_000,
      retries: { retries: 40, minTimeout: 25, maxTimeout: 250 },
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }
  async function readBytes(): Promise<Buffer> {
    try {
      return await readFile(logPath);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return Buffer.alloc(0);
      throw error;
    }
  }
  async function parse(bytes: Buffer): Promise<ParsedLog> {
    // A crash mid-append leaves an unterminated final line that never completed.
    const end = bytes.lastIndexOf(0x0a) + 1;
    const lines = bytes.subarray(0, end).toString('utf8').split('\n').slice(0, -1);
    const log: ParsedLog = {
      start: chainStart,
      events: [],
      complete: end,
      torn: end < bytes.length,
    };
    if (!lines.length) return log;
    let openLine: Awaited<ReturnType<Store['opener']>>;
    try {
      openLine = await store.opener();
    } catch {
      log.firstBad = { line: 1, seq: null, reason: 'The store key is unavailable' };
      return log;
    }
    for (const [index, text] of lines.entries()) {
      const line = index + 1;
      let seq: number | null = null;
      try {
        const record = JSON.parse(text) as { anchor?: boolean; seq?: number; sealed?: unknown };
        if (record.anchor && index === 0) {
          log.start = openLine(record.sealed, anchorAad) as AuditLink;
          continue;
        }
        seq = typeof record.seq === 'number' ? record.seq : null;
        const event = auditEventSchema.parse(openLine(record.sealed, eventAad(seq ?? -1)));
        log.events.push({ line, event });
      } catch {
        // Later events stay readable; verify(), prune and reseal all still see the damage.
        log.firstBad ??= { line, seq, reason: 'Line cannot be authenticated' };
      }
    }
    return log;
  }
  async function readHead(): Promise<AuditHead | undefined> {
    let text: string;
    try {
      text = await readFile(headPath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    const openHead = await store.opener();
    return openHead((JSON.parse(text) as { sealed: unknown }).sealed, headAad) as AuditHead;
  }
  async function writeHead(seal: Sealer, head: AuditHead) {
    await writeAtomic(headPath, `${JSON.stringify({ sealed: seal(head, headAad) })}\n`);
  }
  function sealedEvent(seal: Sealer, event: AuditEvent) {
    return `${JSON.stringify({ seq: event.seq, sealed: seal(event, eventAad(event.seq)) })}\n`;
  }
  function sealedAnchor(seal: Sealer, start: AuditLink) {
    return `${JSON.stringify({ anchor: true, sealed: seal(start, anchorAad) })}\n`;
  }
  async function append(input: AuditInput): Promise<AuditEvent> {
    const log = await parse(await readBytes());
    if (log.torn) await truncate(logPath, log.complete);
    const lastEvent = log.events.at(-1)?.event;
    let link = lastEvent ? nextLink(lastEvent) : log.start;
    if (log.firstBad) {
      // Keep logging after tampering: the broken line stays visible to verify().
      const head = await readHead();
      if (!head) throw new Error('Audit log is damaged and has no readable head');
      link = { seq: head.seq + 1, prevHash: head.hash };
    }
    const event = chainEvent(input, link, now().toISOString());
    const seal = await store.sealer();
    const file = await openFile(logPath, 'a', 0o600);
    try {
      await file.writeFile(sealedEvent(seal, event));
      await file.sync();
    } finally {
      await file.close();
    }
    await writeHead(seal, { seq: event.seq, hash: event.hash });
    return event;
  }
  async function prune(days: number): Promise<number> {
    return withLock(async () => {
      const log = await parse(await readBytes());
      if (log.firstBad) throw new Error('Refusing to prune a damaged audit log');
      const cutoff = now().getTime() - days * dayMs;
      const firstKept = log.events.findIndex(({ event }) => Date.parse(event.at) >= cutoff);
      const dropped = firstKept === -1 ? log.events.length : firstKept;
      if (!dropped) return 0;
      const kept = log.events.slice(dropped);
      const last = log.events[dropped - 1];
      if (!last) return 0;
      const seal = await store.sealer();
      const lines = kept.map(({ event }) => sealedEvent(seal, event));
      await writeAtomic(logPath, [sealedAnchor(seal, nextLink(last.event)), ...lines].join(''));
      await append(
        await describe({
          op: 'audit-retention',
          outcome: 'ok',
          detail: `Dropped ${dropped} events older than ${days} days`,
        }),
      );
      return dropped;
    });
  }
  async function describe(record: AuditRecord): Promise<AuditInput> {
    await store.sealer(); // First write of a new store: creates the key this event names.
    const files = record.files ?? [];
    const omitted = files.length - maxAuditFiles;
    return {
      ...record,
      who: who(),
      keyId: (await store.keyStatus()).keyId,
      files: files.slice(0, maxAuditFiles),
      ...(omitted > 0 ? { filesOmitted: omitted } : {}),
      profiles: record.profiles ?? [],
    };
  }
  async function pruneIfDue() {
    try {
      const days = await options.retentionDays?.();
      if (!days || now().getTime() - lastPruned < dayMs) return;
      await prune(days);
      lastPruned = now().getTime();
    } catch (error) {
      // The event itself is safely written, so this is not an audit write failure.
      process.stderr.write(
        `repo-cloak: audit retention did not run: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return {
    /** Records an event; a failure is counted and reported, never thrown at the caller. */
    async record(record: AuditRecord): Promise<AuditEvent | undefined> {
      try {
        const input = await describe(record);
        const event = await withLock(() => append(input));
        await pruneIfDue();
        return event;
      } catch (error) {
        failures += 1;
        process.stderr.write(
          `repo-cloak: could not write audit event ${randomUUID().slice(0, 8)} (${record.op}): ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return undefined;
      }
    },
    failures: () => failures,
    prune,
    /** Newest first. Unreadable lines are skipped here; verify() is what reports them. */
    async list({ cursor, limit = 100 }: { cursor?: number | undefined; limit?: number } = {}) {
      const log = await parse(await readBytes());
      const events = log.events.map(({ event }) => event).reverse();
      const from = cursor === undefined ? 0 : events.findIndex((event) => event.seq < cursor);
      const page = from === -1 ? [] : events.slice(from, from + limit);
      const more = from !== -1 && from + limit < events.length;
      return {
        events: page,
        total: events.length,
        nextCursor: more ? (page.at(-1)?.seq ?? null) : null,
      };
    },
    async verify(): Promise<AuditVerification> {
      const log = await parse(await readBytes());
      const count = log.events.length;
      if (log.firstBad) {
        const { line } = log.firstBad;
        const intact = log.events.filter((event) => event.line < line).length;
        return { ok: false, count: intact, firstBroken: log.firstBad };
      }
      let head: AuditHead | undefined;
      try {
        head = await readHead();
      } catch {
        return {
          ok: false,
          count,
          firstBroken: { line: count + 1, seq: null, reason: 'Log head cannot be authenticated' },
        };
      }
      const result = verifyChain(
        log.events.map(({ event }) => event),
        { start: log.start, head },
      );
      if (result.ok) return result;
      const { index, seq, reason } = result.firstBroken;
      const line = log.events[index]?.line ?? (log.events.at(-1)?.line ?? 0) + 1;
      return { ok: false, count, firstBroken: { line, seq, reason } };
    },
    /** Re-encrypts every line under the current key; the hash chain is unchanged by this. */
    async reseal(): Promise<number> {
      return withLock(async () => {
        const bytes = await readBytes();
        if (!bytes.length) return 0;
        const log = await parse(bytes);
        if (log.firstBad) throw new Error('Refusing to reseal a damaged audit log');
        const head = await readHead();
        const seal = await store.sealer();
        const first = log.start === chainStart ? [] : [sealedAnchor(seal, log.start)];
        const lines = log.events.map(({ event }) => sealedEvent(seal, event));
        await writeAtomic(logPath, [...first, ...lines].join(''));
        if (head) await writeHead(seal, head);
        return lines.length;
      });
    },
  };
}
export type AuditStore = ReturnType<typeof createAuditStore>;
