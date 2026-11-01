import { describe, expect, it } from 'vitest';
import {
  chainEvent,
  chainStart,
  genesisHash,
  hashEvent,
  nextLink,
  verifyChain,
} from '../../src/core/audit.js';
import type { AuditEvent, AuditInput, AuditLink } from '../../src/core/audit.js';

const input = (overrides: Partial<AuditInput> = {}): AuditInput => ({
  who: 'dev',
  op: 'pull',
  outcome: 'ok',
  files: [{ path: 'src/a.ts', hash: `sha256-${'a'.repeat(64)}` }],
  profiles: [{ id: 'p1', hash: 'sha256-profile' }],
  keyId: 'k_1',
  ...overrides,
});
function at(events: AuditEvent[], index: number): AuditEvent {
  const event = events[index];
  if (!event) throw new Error(`No event ${index}`);
  return event;
}
function chain(count: number, start: AuditLink = chainStart): AuditEvent[] {
  const events: AuditEvent[] = [];
  let link = start;
  for (let index = 0; index < count; index++) {
    const event = chainEvent(input(), link, `2026-01-0${index + 1}T00:00:00.000Z`);
    events.push(event);
    link = nextLink(event);
  }
  return events;
}

describe('chain', () => {
  it('links each event to the previous hash from a fixed genesis', () => {
    const [first, second] = chain(2);
    expect(first?.seq).toBe(0);
    expect(first?.prevHash).toBe(genesisHash);
    expect(second?.seq).toBe(1);
    expect(second?.prevHash).toBe(first?.hash);
  });
  it('hashes canonically, ignoring object key order', () => {
    const [event] = chain(1);
    if (!event) throw new Error('No event');
    const reordered = Object.fromEntries(Object.entries(event).reverse()) as AuditEvent;
    expect(hashEvent(reordered)).toBe(event.hash);
  });
  it('accepts metadata only and rejects anything that could hold file contents', () => {
    expect(() =>
      chainEvent(
        { ...input(), content: 'secret' } as AuditInput,
        chainStart,
        '2026-01-01T00:00:00Z',
      ),
    ).toThrow();
    expect(() =>
      chainEvent(
        input({ files: [{ path: 'a', content: 'secret' } as never] }),
        chainStart,
        '2026-01-01T00:00:00Z',
      ),
    ).toThrow();
    expect(() =>
      chainEvent(input({ detail: 'x'.repeat(501) }), chainStart, '2026-01-01T00:00:00Z'),
    ).toThrow();
  });
});

describe('verifyChain', () => {
  it('accepts an empty and an intact chain', () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0, headHash: null });
    const events = chain(3);
    expect(verifyChain(events)).toEqual({ ok: true, count: 3, headHash: events[2]?.hash });
  });
  it.each([
    [
      'edited field',
      (e: AuditEvent[]) => void (e[1] = { ...at(e, 1), who: 'mallory' }),
      1,
      /contents/,
    ],
    [
      'recomputed hash on an edited event',
      (e: AuditEvent[]) => {
        const edited = { ...at(e, 1), who: 'mallory' };
        e[1] = { ...edited, hash: hashEvent(edited) };
      },
      2,
      /Previous-hash/,
    ],
    ['removed middle event', (e: AuditEvent[]) => void e.splice(1, 1), 1, /sequence/],
    ['removed first event', (e: AuditEvent[]) => void e.shift(), 0, /sequence/],
    ['swapped events', (e: AuditEvent[]) => void e.reverse(), 0, /sequence/],
    ['non-event data', (e: AuditEvent[]) => void (e[1] = { seq: 1 } as AuditEvent), 1, /schema/],
  ])('reports the first broken link for %s', (_name, tamper, index, reason) => {
    const events = chain(4);
    tamper(events);
    const result = verifyChain(events);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.firstBroken.index).toBe(index);
    expect(result.firstBroken.reason).toMatch(reason);
  });
  it('continues from an authenticated retention anchor', () => {
    const all = chain(5);
    const kept = all.slice(3);
    const start = nextLink(at(all, 2));
    expect(verifyChain(kept, { start }).ok).toBe(true);
    expect(verifyChain(kept).ok).toBe(false);
  });
  it('detects a log truncated before its recorded head', () => {
    const events = chain(3);
    const head = { seq: 2, hash: at(events, 2).hash };
    expect(verifyChain(events, { head }).ok).toBe(true);
    const result = verifyChain(events.slice(0, 2), { head });
    expect(result).toMatchObject({ ok: false, firstBroken: { index: 2, seq: 2 } });
    expect(verifyChain([], { head }).ok).toBe(false);
  });
  it('allows the head to lag one event after a crash but not to disagree', () => {
    const events = chain(3);
    expect(verifyChain(events, { head: { seq: 1, hash: at(events, 1).hash } }).ok).toBe(true);
    const result = verifyChain(events, { head: { seq: 1, hash: at(events, 0).hash } });
    expect(result).toMatchObject({ ok: false, firstBroken: { index: 1 } });
  });
});
