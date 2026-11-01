import { expect, it } from 'vitest';
import {
  commands,
  groupCommands,
  registerCommands,
  searchCommands,
} from '../../src/web/shell/commands.js';
import type { Command } from '../../src/web/shell/commands.js';

const command = (id: string, title: string, extra: Partial<Command> = {}): Command => ({
  id,
  group: 'Actions',
  title,
  run: () => {},
  ...extra,
});

it('lets screens add and remove commands, including their CLI equivalent', () => {
  const remove = registerCommands(() => [command('a', 'Alpha', { cli: 'repo-cloak ui' })]);
  expect(commands.value.map((entry) => entry.cli)).toEqual(['repo-cloak ui']);
  remove();
  expect(commands.value).toEqual([]);
});

it('matches every query word across title, subtitle, group and keywords', () => {
  const list = [
    command('a', 'Push acme-care-api', { subtitle: '4 files' }),
    command('b', 'Open settings', { keywords: ['keychain'] }),
  ];
  expect(searchCommands('push api', list).map((entry) => entry.id)).toEqual(['a']);
  expect(searchCommands('KEYCHAIN', list).map((entry) => entry.id)).toEqual(['b']);
  expect(searchCommands('push keychain', list)).toEqual([]);
  expect(searchCommands('  ', list)).toEqual(list);
});

it('groups commands in first-seen order', () => {
  const groups = groupCommands([
    command('a', 'A', { group: 'One' }),
    command('b', 'B', { group: 'Two' }),
    command('c', 'C', { group: 'One' }),
  ]);
  expect(groups.map((group) => [group.name, group.items.length])).toEqual([
    ['One', 2],
    ['Two', 1],
  ]);
});
