import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { createProgram } from '../src/program.js';

describe('createProgram', () => {
  it('uses the package version', () => {
    expect(createProgram().version()).toBe(pkg.version);
  });

  it('is named repo-cloak', () => {
    expect(createProgram().name()).toBe('repo-cloak');
  });
});
