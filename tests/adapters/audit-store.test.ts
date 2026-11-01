import { createPublicKey, verify } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createAuditStore } from '../../src/adapters/audit-store.js';
import { createStore } from '../../src/adapters/store.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(options: Parameters<typeof createAuditStore>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cloak audit '));
  roots.push(root);
  const store = createStore(root);
  const audit = createAuditStore(store, options);
  const log = join(root, 'audit', 'log.jsonl');
  const lines = async () => (await readFile(log, 'utf8')).trimEnd().split('\n');
  return { root, store, audit, log, lines };
}
const pull = (path = 'src/a.ts') => ({
  op: 'pull' as const,
  outcome: 'ok' as const,
  workspace: { id: 'ws1', repoId: 'r1', name: 'cloak' },
  files: [{ path, hash: `sha256-${'a'.repeat(64)}` }],
  profiles: [{ id: 'p1', hash: 'h1' }],
});

it('appends sealed events whose plaintext never reaches the disk', async () => {
  const f = await fixture();
  await f.audit.record(pull('src/ProprietaryName.ts'));
  const raw = await readFile(f.log, 'utf8');
  expect(raw).not.toContain('ProprietaryName');
  expect(raw).not.toContain('"op"');
  const { events } = await f.audit.list();
  expect(events[0]).toMatchObject({
    op: 'pull',
    who: expect.any(String),
    keyId: expect.stringMatching(/^k_/),
    workspace: { id: 'ws1' },
    files: [{ path: 'src/ProprietaryName.ts' }],
    profiles: [{ id: 'p1', hash: 'h1' }],
  });
});

it('verifies an intact chain across concurrent writers', async () => {
  const f = await fixture();
  const other = createAuditStore(f.store);
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? f.audit : other).record(pull(`f${index}`)),
    ),
  );
  const result = await f.audit.verify();
  expect(result).toMatchObject({ ok: true, count: 12 });
  expect((await f.audit.list()).events.map((event) => event.seq)).toEqual(
    Array.from({ length: 12 }, (_, index) => 11 - index),
  );
});

it('detects a tampered line and reports it as the first broken link', async () => {
  const f = await fixture();
  for (const path of ['a', 'b', 'c']) await f.audit.record(pull(path));
  const lines = await f.lines();
  const record = JSON.parse(lines[1] ?? '') as { sealed: { data: string } };
  const data = Buffer.from(record.sealed.data, 'base64');
  data[0] = (data[0] ?? 0) ^ 0xff;
  record.sealed.data = data.toString('base64');
  lines[1] = JSON.stringify(record);
  await writeFile(f.log, `${lines.join('\n')}\n`);
  expect(await f.audit.verify()).toEqual({
    ok: false,
    count: 1,
    firstBroken: { line: 2, seq: 1, reason: 'Line cannot be authenticated' },
  });
});

it.each([
  ['a removed middle line', (lines: string[]) => [lines[0], lines[2]], 2],
  ['swapped lines', (lines: string[]) => [lines[1], lines[0], lines[2]], 1],
  ['a truncated tail', (lines: string[]) => lines.slice(0, 2), 3],
  ['a replayed line', (lines: string[]) => [...lines, lines[2]], 4],
])('detects %s', async (_name, change, line) => {
  const f = await fixture();
  for (const path of ['a', 'b', 'c']) await f.audit.record(pull(path));
  await writeFile(f.log, `${change(await f.lines()).join('\n')}\n`);
  const result = await f.audit.verify();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.firstBroken.line).toBe(line);
});

it('flags a log deleted from under its head', async () => {
  const f = await fixture();
  await f.audit.record(pull());
  await rm(f.log);
  expect((await f.audit.verify()).ok).toBe(false);
});

it('recovers from a crash that left an unterminated final line', async () => {
  const f = await fixture();
  await f.audit.record(pull('a'));
  await appendFile(f.log, '{"seq":1,"sealed":{"al');
  expect(await f.audit.verify()).toMatchObject({ ok: true, count: 1 });
  await f.audit.record(pull('b'));
  expect(await f.audit.verify()).toMatchObject({ ok: true, count: 2 });
});

it('keeps logging after tampering without hiding the damage', async () => {
  const f = await fixture();
  await f.audit.record(pull('a'));
  await writeFile(f.log, 'garbage\n');
  const event = await f.audit.record(pull('b'));
  expect(event?.seq).toBe(1);
  expect(await f.audit.verify()).toMatchObject({ ok: false, firstBroken: { line: 1 } });
});

it('drops expired events, keeps the chain verifiable and logs the retention itself', async () => {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const f = await fixture({ now: () => new Date(time) });
  await f.audit.record(pull('old-1'));
  await f.audit.record(pull('old-2'));
  time += 40 * 86_400_000;
  await f.audit.record(pull('recent'));
  expect(await f.audit.prune(30)).toBe(2);
  expect(await f.audit.prune(30)).toBe(0);
  const { events } = await f.audit.list();
  expect(events.map((event) => event.op)).toEqual(['audit-retention', 'pull']);
  expect(events[1]?.files[0]?.path).toBe('recent');
  expect(events[1]?.seq).toBe(2);
  expect(await f.audit.verify()).toMatchObject({ ok: true, count: 2 });
  // Removing the anchor must not pass for an intact log.
  const lines = await f.lines();
  await writeFile(f.log, `${lines.slice(1).join('\n')}\n`);
  expect((await f.audit.verify()).ok).toBe(false);
});

it('stays verifiable when retention drops every event', async () => {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const f = await fixture({ now: () => new Date(time) });
  await f.audit.record(pull());
  time += 40 * 86_400_000;
  expect(await f.audit.prune(30)).toBe(1);
  expect(await f.audit.verify()).toMatchObject({ ok: true, count: 1 });
});

it('applies configured retention automatically, at most daily', async () => {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const f = await fixture({ now: () => new Date(time), retentionDays: async () => 30 });
  await f.audit.record(pull('first'));
  time += 40 * 86_400_000;
  await f.audit.record(pull('second'));
  const paths = (await f.audit.list()).events.flatMap((event) => event.files.map((x) => x.path));
  expect(paths).toEqual(['second']);
  expect(await f.audit.verify()).toMatchObject({ ok: true });
});

it('reports failures without throwing at the operation being audited', async () => {
  const f = await fixture();
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await writeFile(join(f.root, 'audit'), 'not a directory');
  expect(await f.audit.record(pull())).toBeUndefined();
  expect(f.audit.failures()).toBe(1);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('could not write audit event'));
});

it('caps events with very many files and records how many were left out', async () => {
  const f = await fixture();
  const files = Array.from({ length: 5002 }, (_, index) => ({ path: `f${index}` }));
  const event = await f.audit.record({ op: 'pull', outcome: 'ok', files });
  expect(event?.files).toHaveLength(5000);
  expect(event?.filesOmitted).toBe(2);
});

it('pages newest first', async () => {
  const f = await fixture();
  for (const path of ['a', 'b', 'c']) await f.audit.record(pull(path));
  const first = await f.audit.list({ limit: 2 });
  expect(first.events.map((event) => event.seq)).toEqual([2, 1]);
  expect(first).toMatchObject({ total: 3, nextCursor: 1 });
  const second = await f.audit.list({ limit: 2, cursor: first.nextCursor ?? undefined });
  expect(second.events.map((event) => event.seq)).toEqual([0]);
  expect(second.nextCursor).toBeNull();
});

it('lists events on both sides of a damaged line while verify still reports it', async () => {
  const f = await fixture();
  for (const path of ['a', 'b', 'c']) await f.audit.record(pull(path));
  const lines = await f.lines();
  lines[1] = 'garbage';
  await writeFile(f.log, `${lines.join('\n')}\n`);
  await f.audit.record(pull('d'));
  const paths = (await f.audit.list()).events.flatMap((event) => event.files.map((x) => x.path));
  expect(paths).toEqual(['d', 'c', 'a']);
  expect(await f.audit.verify()).toMatchObject({ ok: false, firstBroken: { line: 2 } });
});

it('does not count a retention failure as a failed write, and retries it', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let time = Date.parse('2026-01-01T00:00:00Z');
  const f = await fixture({ now: () => new Date(time), retentionDays: async () => 30 });
  await f.audit.record(pull('a'));
  await writeFile(f.log, 'garbage\n');
  time += 2 * 86_400_000;
  expect(await f.audit.record(pull('b'))).toBeDefined();
  expect(await f.audit.record(pull('c'))).toBeDefined();
  expect(f.audit.failures()).toBe(0);
  const warnings = stderr.mock.calls.filter(([text]) =>
    String(text).includes('audit retention did not run'),
  );
  expect(warnings).toHaveLength(2);
});

it('signs exports with one lasting key that survives a reseal and stays sealed', async () => {
  const { audit, root, store } = await fixture();
  await audit.record(pull());
  const bytes = Buffer.from('export');
  const first = await audit.signExport(bytes);
  expect(first.fingerprint).toMatch(/^SHA256:[a-f0-9]{64}$/);
  expect(
    verify(null, bytes, createPublicKey(first.publicKey), Buffer.from(first.signature, 'base64')),
  ).toBe(true);
  expect(await readFile(join(root, 'audit', 'signing-key.json'), 'utf8')).not.toContain('PRIVATE');
  await audit.reseal();
  expect((await audit.signExport(bytes)).fingerprint).toBe(first.fingerprint);
  // A later process over the same store gets the same identity.
  expect((await createAuditStore(store).signExport(bytes)).fingerprint).toBe(first.fingerprint);
});

it('refuses to sign rather than replace a damaged signing key', async () => {
  const { audit, root } = await fixture();
  await audit.signExport(Buffer.from('export'));
  const path = join(root, 'audit', 'signing-key.json');
  const sealed = JSON.parse(await readFile(path, 'utf8')) as { sealed: { data: string } };
  sealed.sealed.data = Buffer.alloc(40, 1).toString('base64');
  await writeFile(path, JSON.stringify(sealed));
  await expect(audit.signExport(Buffer.from('export'))).rejects.toThrow();
});
