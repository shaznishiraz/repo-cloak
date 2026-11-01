import { describe, expect, it } from 'vitest';
import { regexSafetyProblem } from '../../src/core/regex-safety.js';

describe('regexSafetyProblem', () => {
  it.each([
    '(a+)+$',
    '(a+)*',
    '(a*)*',
    '(?:a+)+',
    '(a+b)+',
    '(\\w+\\.)+',
    '((a+))+',
    '(a{1,200}){1,200}',
    '(a+){100,}',
    '(?=(a+)+)x',
    '(?<!(a+)+)x',
    '(?<name>a+)+',
    '(x|(a+))+',
  ])('rejects nested %s', (pattern) => {
    expect(regexSafetyProblem(pattern)).toMatch(/nested/);
  });

  it.each(['(a?a)+', '(a{1,3})+', '(a?b?)+', '([a-z]{1,9}x?)+', '(a?){5,}', '(aa?)+'])(
    'rejects overlapping variable parts in %s',
    (pattern) => {
      expect(regexSafetyProblem(pattern)).toMatch(/repeated group/);
    },
  );

  it.each(['(a|a)*', '(a|ab)+', '(\\w|\\d)+', '(.|a)*', '([a-c]|b)+', '(A|a)+'])(
    'rejects overlapping alternatives in %s',
    (pattern) => {
      expect(regexSafetyProblem(pattern, pattern === '(A|a)+' ? 'i' : '')).toMatch(/alternatives/);
    },
  );

  it.each(['\\d+\\d*', '.*.*', 'a*a*', '\\s*\\s*', 'a+b?a+', '\\w+\\d+', '[a-z]+[m-p]+'])(
    'rejects adjacent overlapping loops in %s',
    (pattern) => {
      expect(regexSafetyProblem(pattern)).toMatch(/in a row/);
    },
  );

  it.each([
    'CH-(\\d{6})',
    '(?<![A-Za-z0-9_])Contoso(?![A-Za-z0-9_])',
    '\\d{1,3}(\\.\\d{1,3}){3}',
    '(foo|bar)+',
    '(ab?)+',
    '(.|\\n)*',
    '\\w+@\\w+\\.com',
    '[a-z]+\\d+',
    'id-(?<id>[0-9a-f]{8})',
    '.*foo.*',
    '\\bfoo\\b',
    '[\\]\\\\]+x',
    '\\u0041+\\x42+',
    '\\p{L}+ x',
    '(a)\\1',
    'a{2}{',
    '^(.*?,){11}P',
  ])('accepts %s', (pattern) => {
    expect(regexSafetyProblem(pattern, pattern.includes('\\p') ? 'u' : '')).toBeUndefined();
  });

  it('treats a dot as overlapping everything only under the s flag', () => {
    expect(regexSafetyProblem('(.|\\n)*', 's')).toMatch(/alternatives/);
  });

  it('treats case-insensitive letters as overlapping', () => {
    expect(regexSafetyProblem('a+A+', 'i')).toMatch(/in a row/);
    expect(regexSafetyProblem('a+A+')).toBeUndefined();
  });

  it('treats backreferences and unicode classes as possibly overlapping', () => {
    expect(regexSafetyProblem('(a)(\\1|a)+')).toMatch(/alternatives|repeated/);
    expect(regexSafetyProblem('\\p{L}+a+', 'u')).toMatch(/in a row/);
  });

  it('fails closed on what it cannot follow', () => {
    expect(regexSafetyProblem('(?i:a)+')).toMatch(/too complex/);
    expect(regexSafetyProblem(`${'('.repeat(70)}a${')'.repeat(70)}`)).toMatch(/too complex/);
    expect(regexSafetyProblem('a'.repeat(2001))).toMatch(/longer/);
  });

  it('terminates on every valid pattern, however odd', () => {
    const pieces = [
      '(',
      ')',
      '(?:',
      '(?=',
      '(?<n>',
      '[',
      ']',
      '\\',
      'u{',
      'x',
      '{',
      '}',
      '1,',
      '+',
      '*',
      '?',
      '|',
      'a',
      '.',
      '^',
      '$',
      '\\k<n>',
      '\\1',
      '\\p{',
      'L}',
      '-',
    ];
    let seed = 63;
    const next = (limit: number) => (seed = (seed * 48271) % 2147483647) % limit;
    for (let run = 0; run < 3000; run++) {
      const source = Array.from({ length: next(12) }, () => pieces[next(pieces.length)]).join('');
      for (const flags of ['', 'u']) {
        try {
          new RegExp(source, flags);
        } catch {
          continue;
        }
        const problem = regexSafetyProblem(source, flags);
        expect(problem === undefined || typeof problem === 'string').toBe(true);
      }
    }
  });
});
