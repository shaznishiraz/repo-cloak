import { expect, it } from 'vitest';
import { expandReplacement as expand } from '../../src/core/regex.js';

const expandReplacement = (template: string, match: RegExpExecArray) =>
  expand(template, {
    index: match.index,
    captures: [...match],
    ...(match.groups ? { groups: match.groups } : {}),
  });

it.each(['$1', '$2', '$10', '$99', '$0', '$00', '$01', '$$', '$&', '$<missing>', '$1-$$-$2'])(
  'matches JavaScript capture semantics for %s',
  (template) => {
    const pattern = /(bill)(ing)?/;
    const input = 'billing';
    const match = pattern.exec(input);
    if (!match) throw new Error('Missing test match');
    expect(expandReplacement(template, match)).toBe(input.replace(pattern, template));
  },
);
it('handles missing numbered and named optional captures like JavaScript', () => {
  const pattern = /(?<service>bill)(?<suffix>ing)?/;
  const input = 'bill';
  const match = pattern.exec(input);
  if (!match) throw new Error('Missing test match');
  const template = '$1/$2/$<service>/$<suffix>/$<unknown>';
  expect(expandReplacement(template, match)).toBe(input.replace(pattern, template));
});
it.each(['$`', "$'"])('refuses copying input outside a match with %s', (template) => {
  const match = /bill/.exec('billing');
  if (!match) throw new Error('Missing test match');
  expect(() => expandReplacement(template, match)).toThrow('cannot copy');
});
