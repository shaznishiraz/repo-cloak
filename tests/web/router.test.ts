import { expect, it } from 'vitest';
import { parseRoute } from '../../src/web/shell/router.js';

it.each([
  ['', { screen: 'home' }],
  ['#/', { screen: 'home' }],
  ['#/new', { screen: 'new' }],
  ['#/ws/abc', { screen: 'home', workspaceId: 'abc' }],
  ['#/ws/a%2Fb', { screen: 'home', workspaceId: 'a/b' }],
  ['#/ws/abc/push', { screen: 'push', workspaceId: 'abc' }],
  ['#/groups/g1', { screen: 'group', groupId: 'g1' }],
  ['#/repos', { screen: 'repos' }],
  ['#/requests', { screen: 'requests' }],
  ['#/profiles', { screen: 'profiles' }],
  ['#/profiles/p1', { screen: 'profiles', profileId: 'p1' }],
  ['#/profiles/p1/json', { screen: 'profiles', profileId: 'p1', json: true }],
  ['#/history', { screen: 'history' }],
  ['#/settings', { screen: 'settings' }],
  ['#/setup', { screen: 'setup' }],
])('parses %s', (hash, expected) => {
  expect(parseRoute(hash)).toEqual(expected);
});

it.each(['#/nope', '#/ws', '#/ws/a/b', '#/groups', '#/profiles/p/yaml', '#/ws/%E0%A4%A', 'plain'])(
  'treats %s as not found',
  (hash) => {
    expect(parseRoute(hash)).toEqual({ screen: 'not-found', hash });
  },
);
