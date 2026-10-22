import { describe, expect, it } from 'vitest';
import { compilePatterns, normalizePattern, patternProblem } from '../../src/core/patterns.js';

describe('profile file patterns', () => {
  it('normalizes .gitignore-style patterns to repository-relative globs', () => {
    expect(normalizePattern('*.schema.json')).toBe('**/*.schema.json');
    expect(normalizePattern('generated/')).toBe('**/generated/**');
    expect(normalizePattern('/schema.sql')).toBe('schema.sql');
    expect(normalizePattern('./src/gen/**')).toBe('src/gen/**');
    expect(normalizePattern('src/**/*.gen.ts')).toBe('src/**/*.gen.ts');
  });

  it('matches names in every folder, folders with their contents, and anchored paths', () => {
    const matches = compilePatterns(['*.schema.json', 'generated/', '/schema.sql', 'fixtures']);
    expect(matches('user.schema.json')).toBe(true);
    expect(matches('src/api/User.Schema.JSON')).toBe(true);
    expect(matches('src/generated/a.ts')).toBe(true);
    expect(matches('generated/deep/b.ts')).toBe(true);
    expect(matches('schema.sql')).toBe(true);
    expect(matches('db/schema.sql')).toBe(false);
    // A bare name also covers a folder of that name.
    expect(matches('tests/fixtures/data.json')).toBe(true);
    expect(matches('src/schema.ts')).toBe(false);
    expect(matches('src/generator.ts')).toBe(false);
    expect(compilePatterns([])('anything')).toBe(false);
  });

  it('explains unusable patterns', () => {
    expect(patternProblem('*.schema.json')).toBeUndefined();
    expect(patternProblem('')).toMatch(/blank/);
    expect(patternProblem(' *.ts')).toMatch(/spaces/);
    expect(patternProblem('!keep.ts')).toMatch(/negation/);
    expect(patternProblem('src\\gen')).toMatch(/separator/);
    expect(patternProblem('C:/repo/x')).toMatch(/relative/);
    expect(patternProblem('../outside/**')).toMatch(/outside/);
    expect(patternProblem('src/../../x')).toMatch(/outside/);
    expect(patternProblem('/')).toMatch(/name a file/);
    expect(patternProblem('./')).toMatch(/name a file/);
  });
});
