import { expect, it } from 'vitest';
import { clearSession, readSession } from '../../src/web/api/session.js';

function memory() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

it('moves the fragment token into storage and lands on the launch context', () => {
  const storage = memory();
  const session = readSession('#token=abc&repo=r1&workspace=ws%2F1', storage);
  expect(session.token).toBe('abc');
  expect(session.route).toBe('#/ws/ws%2F1');
  expect(session.route).not.toContain('abc');
  expect(storage.items.get('cloak-token')).toBe('abc');
  expect(session.launch).toEqual({ repo: 'r1', workspace: 'ws/1' });
});

it('keeps the stored session across route-only fragments and reloads', () => {
  const storage = memory();
  readSession('#token=abc&group=g1', storage);
  const reload = readSession('#/profiles', storage);
  expect(reload).toEqual({ token: 'abc', launch: { group: 'g1' }, route: '#/profiles' });
});

it('reports no token when opened without a launch link', () => {
  expect(readSession('', memory())).toEqual({ token: null, launch: {}, route: '#/' });
});

it('survives corrupt stored launch data', () => {
  const storage = memory();
  storage.setItem('cloak-launch', '{nope');
  expect(readSession('#/', storage).launch).toEqual({});
});

it('forgets the token and launch context when a tab locks', () => {
  const items = new Map([
    ['cloak-token', 'abc'],
    ['cloak-launch', '{}'],
    ['other', 'kept'],
  ]);
  clearSession({ removeItem: (key: string) => void items.delete(key) });
  expect([...items.keys()]).toEqual(['other']);
});
