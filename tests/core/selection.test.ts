import { expect, it } from 'vitest';
import { selectFiles } from '../../src/core/selection.js';

it('unions explicit files, commits, working changes and extra paths once', () => {
  const result = selectFiles({
    files: ['src/a.ts', 'src/b.ts'],
    commits: [['src/b.ts', 'src/c.ts'], ['src/a.ts']],
    working: ['src/c.ts', 'src/d.ts'],
    extra: ['src/d.ts', 'src/e.ts'],
  });
  expect(result).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
});
it('normalizes Windows separators and refuses traversal', () => {
  expect(selectFiles({ files: ['src\\a.ts', 'src/a.ts'] })).toEqual(['src/a.ts']);
  expect(() => selectFiles({ files: ['../escape'] })).toThrow(/path/);
});
