import { describe, expect, it } from 'vitest';
import { anonymizePaths, restorePaths } from '../../src/core/paths.js';
import { createReplacer } from '../../src/core/replacer.js';

const engine = () =>
  createReplacer([
    { id: 'company', type: 'literal', match: 'Acme Corp', replace: 'Northwind Traders' },
  ]);
describe('path replacement', () => {
  it('anonymizes segments and restores both existing and new paths', () => {
    const replacer = engine();
    const result = anonymizePaths(['src/AcmeCorp/acme-corp.config.ts'], replacer);
    expect(result.paths).toEqual([
      {
        original: 'src/AcmeCorp/acme-corp.config.ts',
        anonymized: 'src/NorthwindTraders/northwind-traders.config.ts',
      },
    ]);
    expect(
      restorePaths(
        ['src/NorthwindTraders/northwind-traders.config.ts', 'src/NorthwindTradersClient.ts'],
        replacer,
        result.ledger,
      ).paths,
    ).toEqual([
      {
        original: 'src/AcmeCorp/acme-corp.config.ts',
        anonymized: 'src/NorthwindTraders/northwind-traders.config.ts',
      },
      { original: 'src/AcmeCorpClient.ts', anonymized: 'src/NorthwindTradersClient.ts' },
    ]);
  });
  it('accepts Windows separators and produces portable manifest paths', () => {
    expect(anonymizePaths(['src\\AcmeCorp\\file.ts'], engine()).paths[0]?.anonymized).toBe(
      'src/NorthwindTraders/file.ts',
    );
  });
  it('refuses collisions including case-only differences', () => {
    expect(() => anonymizePaths(['AcmeCorp.ts', 'acmeCorp.ts'], engine())).toThrow(/collision/i);
    expect(() => anonymizePaths(['AcmeCorp/a.ts', 'acmeCorp/b.ts'], engine())).toThrow(
      /collision/i,
    );
  });
  it('refuses file/directory collisions even when input order is reversed', () => {
    expect(() => anonymizePaths(['folder/a.ts', 'folder'], engine())).toThrow(/collision/i);
  });
  it.each([
    '../outside.ts',
    '/etc/passwd',
    'C:\\outside.ts',
    '\\\\server\\file',
    'a/../file',
    'CON.txt',
    'COM¹.txt',
    'con .txt',
    'a/.GiT/config',
    'a/NUL',
    'a/file.',
    'a/file ',
    'a/file:stream',
    '.git/config',
    '.repo-cloak/manifest.json',
  ])('refuses unsafe paths: %s', (path) => {
    expect(() => anonymizePaths([path], engine())).toThrow(/path|name/i);
  });
  it('validates replacement segments rather than allowing traversal or reserved names', () => {
    const replacer = createReplacer([{ id: 'name', type: 'regex', match: 'Acme', replace: '..' }]);
    expect(() => anonymizePaths(['Acme/file.ts'], replacer)).toThrow(/path|name/i);
  });
});
