import { expect, it, vi } from 'vitest';
import { createSessionGate } from '../../src/adapters/session-gate.js';

const compare = vi.hoisted(() => vi.fn<(a: Buffer, b: Buffer) => boolean>());
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: Buffer, b: Buffer) => {
      compare(a, b);
      return actual.timingSafeEqual(a, b);
    },
  };
});

const minute = 60_000;
function gate(limit: number | null | (() => Promise<number | null>) = null) {
  const clock = { now: 1_000_000 };
  const instance = createSessionGate({
    token: 'first',
    launcherKey: 'key',
    idleLimit: typeof limit === 'function' ? limit : async () => limit,
    now: () => clock.now,
  });
  return { clock, instance };
}
const bearer = (value: string) => `Bearer ${value}`;

it('accepts live tokens only, in the exact Bearer form', async () => {
  const { instance } = gate();
  expect(await instance.authorize(bearer('first'))).toBe(true);
  for (const bad of [undefined, '', 'first', bearer('firs'), bearer('firstt'), 'bearer first'])
    expect(await instance.authorize(bad)).toBe(false);
});

it('compares digests in constant time, against every token without stopping early', async () => {
  const { instance } = gate();
  await instance.launch(bearer('key'));
  compare.mockClear();
  expect(await instance.authorize(bearer('first'))).toBe(true);
  // Twice for each of the two tokens: once before the sweep and once after.
  expect(compare).toHaveBeenCalledTimes(4);
  compare.mockClear();
  expect(await instance.authorize(bearer('a much longer wrong value than any token'))).toBe(false);
  expect(compare).toHaveBeenCalledTimes(2);
  for (const [supplied, entry] of compare.mock.calls) {
    expect(supplied).toHaveLength(32);
    expect(entry).toHaveLength(32);
  }
});

it('revokes every token, and a revoked token never comes back', async () => {
  const { instance } = gate();
  const second = (await instance.launch(bearer('key'))) ?? '';
  instance.revoke();
  expect(await instance.authorize(bearer('first'))).toBe(false);
  expect(await instance.authorize(bearer(second))).toBe(false);
  const third = (await instance.launch(bearer('key'))) ?? '';
  expect(await instance.authorize(bearer(third))).toBe(true);
  expect(third).not.toBe(second);
  expect(await instance.authorize(bearer('first'))).toBe(false);
  expect(await instance.authorize(bearer(second))).toBe(false);
});

it('issues a distinct 256-bit token per launch and keeps other tabs signed in', async () => {
  const { instance } = gate();
  const a = (await instance.launch(bearer('key'))) ?? '';
  const b = (await instance.launch(bearer('key'))) ?? '';
  expect(a).toMatch(/^[a-f0-9]{64}$/);
  expect(b).not.toBe(a);
  for (const token of ['first', a, b]) expect(await instance.authorize(bearer(token))).toBe(true);
});

it('keeps the launcher key and browser tokens apart', async () => {
  const { instance } = gate();
  expect(await instance.authorize(bearer('key'))).toBe(false);
  expect(await instance.launch(bearer('first'))).toBeNull();
  expect(await instance.launch(undefined)).toBeNull();
  expect(await instance.launch('key')).toBeNull();
});

it('never issues a token without a launcher key', async () => {
  const instance = createSessionGate({ token: 't', idleLimit: async () => null });
  expect(await instance.launch(undefined)).toBeNull();
  expect(await instance.launch('Bearer ')).toBeNull();
  expect(await instance.launch('Bearer undefined')).toBeNull();
});

it('expires at the limit, exactly, and stays expired', async () => {
  const { clock, instance } = gate(5);
  clock.now += 5 * minute - 1;
  expect(await instance.authorize(bearer('first'))).toBe(true);
  clock.now += 1;
  expect(await instance.authorize(bearer('first'))).toBe(false);
  clock.now += minute;
  instance.activity();
  expect(await instance.authorize(bearer('first'))).toBe(false);
});

it('counts only activity, not authorized requests, as use', async () => {
  const { clock, instance } = gate(5);
  for (let polled = 0; polled < 19; polled++) {
    clock.now += 15_000;
    expect(await instance.authorize(bearer('first'))).toBe(true);
  }
  clock.now += 15_000;
  expect(await instance.authorize(bearer('first'))).toBe(false);
});

it('moves the idle clock on activity', async () => {
  const { clock, instance } = gate(5);
  clock.now += 4 * minute;
  instance.activity();
  clock.now += 4 * minute;
  expect(await instance.authorize(bearer('first'))).toBe(true);
  clock.now += minute;
  expect(await instance.authorize(bearer('first'))).toBe(false);
});

it('a launch after the limit does not rescue the expired tokens', async () => {
  const { clock, instance } = gate(5);
  clock.now += 6 * minute;
  const fresh = (await instance.launch(bearer('key'))) ?? '';
  expect(await instance.authorize(bearer('first'))).toBe(false);
  expect(await instance.authorize(bearer(fresh))).toBe(true);
});

it('a launch restarts the clock, so the new tab gets the whole limit', async () => {
  const { clock, instance } = gate(5);
  clock.now += 4 * minute;
  const fresh = (await instance.launch(bearer('key'))) ?? '';
  clock.now += 4 * minute;
  expect(await instance.authorize(bearer(fresh))).toBe(true);
});

it('does not expire while the limit is unset, or the moment one is set', async () => {
  let limit: number | null = null;
  const { clock, instance } = gate(async () => limit);
  clock.now += 600 * minute;
  expect(await instance.authorize(bearer('first'))).toBe(true);
  limit = 5;
  expect(await instance.authorize(bearer('first'))).toBe(true);
  clock.now += 5 * minute;
  expect(await instance.authorize(bearer('first'))).toBe(false);
});

it('applies a lowered limit at once', async () => {
  let limit = 60;
  const { clock, instance } = gate(async () => limit);
  clock.now += 10 * minute;
  expect(await instance.authorize(bearer('first'))).toBe(true);
  limit = 5;
  expect(await instance.authorize(bearer('first'))).toBe(false);
});

it('keeps the last known limit when settings cannot be read', async () => {
  let fail = false;
  const { clock, instance } = gate(async () => {
    if (fail) throw new Error('unreadable');
    return 5;
  });
  expect(await instance.authorize(bearer('first'))).toBe(true);
  fail = true;
  clock.now += 4 * minute;
  expect(await instance.authorize(bearer('first'))).toBe(true);
  clock.now += minute;
  expect(await instance.authorize(bearer('first'))).toBe(false);
});

it('refuses a token revoked while the limit was being read', async () => {
  let release = () => {};
  const { instance } = gate(
    () => new Promise<number | null>((done) => (release = () => done(null))),
  );
  const pending = instance.authorize(bearer('first'));
  instance.revoke();
  release();
  expect(await pending).toBe(false);
});
