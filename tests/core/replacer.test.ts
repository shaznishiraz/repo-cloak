import { describe, expect, it } from 'vitest';
import { createReplacer } from '../../src/core/replacer.js';
import type { Rule } from '../../src/core/rules.js';

const context = { file: 'src/example.ts', scope: 'content' } as const;
function literal(match = 'Acme', replace = 'Northwind', extra: Partial<Rule> = {}): Rule {
  return { id: 'company', type: 'literal', match, replace, ...extra } as Rule;
}
describe('literal replacement and exact restoration', () => {
  it('round-trips casing, whitespace, BOM and CRLF exactly', () => {
    const engine = createReplacer([literal()]);
    const text = "\uFEFFclass AcmeClient {\r\n  acme = ACME_API; // Acmes, Acme's\r\n}\r\n";
    const result = engine.anonymize(text, context);
    expect(result.text).toContain('NorthwindClient');
    expect(result.text).toContain('NORTHWIND_API');
    expect(engine.restore(result.text, result.ledger, context).text).toBe(text);
  });
  it('chooses the longest matching name at each position', () => {
    const engine = createReplacer([literal(), literal('AcmeCorp', 'ContosoGroup', { id: 'corp' })]);
    expect(engine.anonymize('AcmeCorp Acme', context).text).toBe('ContosoGroup Northwind');
  });
  it('renders both sides in the same style', () => {
    const engine = createReplacer([literal('Acme Corp', 'Northwind Traders')]);
    const text =
      'AcmeCorp acmeCorp acme_corp ACME_CORP acme-corp Acme_Corp Acme-Corp com.acme.corp';
    const result = engine.anonymize(text, context);
    expect(result.text).toBe(
      'NorthwindTraders northwindTraders northwind_traders NORTHWIND_TRADERS northwind-traders Northwind_Traders Northwind-Traders com.northwind.traders',
    );
    expect(engine.restore(result.text, result.ledger, context).text).toBe(text);
  });
  it('recognizes identifier boundaries but leaves unrelated words alone', () => {
    const engine = createReplacer([literal(), literal('Ion', 'Zephyr', { id: 'ion' })]);
    const result = engine.anonymize(
      'getAcmeToken ACME_API Acmeology Function action Ion XMLAcme2',
      context,
    );
    expect(result.text).toBe(
      'getNorthwindToken NORTHWIND_API Acmeology Function action Zephyr XMLNorthwind2',
    );
    expect(result.preview).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'company', status: 'skipped', reason: 'boundary' }),
      ]),
    );
  });
  it('supports word/anywhere modes and explicit exceptions', () => {
    const word = createReplacer([literal('Acme', 'Northwind', { boundary: 'word' })]);
    expect(word.anonymize('getAcmeToken Acme', context).text).toBe('getAcmeToken Northwind');
    const anywhere = createReplacer([
      literal('Acme', 'Northwind', { boundary: 'anywhere', except: ['Acmeology'] }),
    ]);
    const result = anywhere.anonymize('myAcmeclient Acmeology', context);
    expect(result.text).toBe('myNorthwindclient Acmeology');
    expect(result.preview).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'except' })]),
    );
  });
  it('uses explicit styles for common words', () => {
    expect(() => createReplacer([literal('Meta', 'Northwind')])).toThrow(/company.*styles/);
    const engine = createReplacer([
      literal('Meta', 'Northwind', { styles: ['title', 'pascal', 'upper'] }),
    ]);
    expect(
      engine.anonymize('MetaClient META_TOKEN metadata metaTags getMetaData', context).text,
    ).toBe('NorthwindClient NORTHWIND_TOKEN metadata metaTags getNorthwindData');
    expect(
      createReplacer([literal('Meta', 'Northwind', { common: false })]).anonymize('meta', context)
        .text,
    ).toBe('northwind');
  });
  it('restores new literal forms and marks them as new in the preview', () => {
    const engine = createReplacer([literal('Acme Corp', 'Northwind Traders')]);
    const pulled = engine.anonymize('AcmeCorp', context);
    const restored = engine.restore(
      `${pulled.text}Client\nNORTHWIND_TRADERS_V2`,
      pulled.ledger,
      context,
    );
    expect(restored.text).toBe('AcmeCorpClient\nACME_CORP_V2');
    expect(restored.preview).toEqual(
      expect.arrayContaining([expect.objectContaining({ isNew: true, line: 2, column: 1 })]),
    );
  });
  it('records irregular forms and restores their exact spelling', () => {
    const engine = createReplacer([
      literal('Acme Corp', 'Northwind Traders', { forms: ['ACMEcorp'] }),
    ]);
    const pulled = engine.anonymize('ACMEcorp', context);
    expect(pulled.text).not.toContain('ACME');
    expect(engine.restore(pulled.text, pulled.ledger, context).text).toBe('ACMEcorp');
  });
  it('matches NFC names in NFD input without normalizing unrelated text', () => {
    const engine = createReplacer([literal('Müller', 'Nordwind')]);
    const text = `const Mu\u0308llerClient = 'cafe\u0301';\r\n`;
    const pulled = engine.anonymize(text, context);
    expect(pulled.text).toBe("const NordwindClient = 'cafe\u0301';\r\n");
    expect(engine.restore(pulled.text, pulled.ledger, context).text).toBe(text);
  });
  it('warns on short originals and weak replacement words', () => {
    const engine = createReplacer([literal('Ion', 'Data')]);
    expect(engine.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'company', code: 'short-name' }),
        expect.objectContaining({ code: 'weak-replacement' }),
      ]),
    );
  });
});

describe('reversibility checks', () => {
  it('names both rules when their variants collide', () => {
    expect(() =>
      createReplacer([
        literal('Acme Corp', 'Northwind Traders'),
        literal('AcmeCorp', 'ContosoGroup', { id: 'other' }),
      ]),
    ).toThrow(/company.*other/);
    expect(() =>
      createReplacer([
        literal('Acme', 'Northwind', { id: 'one' }),
        literal('Other', 'northwind', { id: 'two' }),
      ]),
    ).toThrow(/one.*two/);
  });
  it('refuses pre-existing anonymized values with the source location', () => {
    const engine = createReplacer([literal()]);
    expect(() => engine.anonymize('Acme\nNorthwind', context)).toThrow(/src\/example.ts:2/);
  });
  it('stops on mixed-case residues and reports file and line', () => {
    const engine = createReplacer([literal('Acme Corp', 'Northwind Traders')]);
    expect(() => engine.restore('ok\nNORTHWINDtraders', [], context)).toThrow(
      /src\/example.ts:2.*anonymized/i,
    );
  });
  it('refuses ambiguous concrete pairs without changing the caller ledger', () => {
    const engine = createReplacer([literal('Acme Corp', 'Northwind')]);
    const first = engine.anonymize('AcmeCorp', context);
    const before = structuredClone(first.ledger);
    expect(() => engine.anonymize('Acme_Corp', context, first.ledger)).toThrow(
      /ambiguous|one-to-one/i,
    );
    expect(first.ledger).toEqual(before);
  });
  it('leaves disabled and other-scope rules inactive', () => {
    const engine = createReplacer([
      literal('Acme', 'Northwind', { scope: 'paths' }),
      literal('Contoso', 'Zephyr', { id: 'off', enabled: false }),
    ]);
    expect(engine.anonymize('Acme Contoso', context).text).toBe('Acme Contoso');
    const path = { file: 'Acme.ts', scope: 'paths' } as const;
    const pulled = engine.anonymize('Acme', path);
    expect(engine.restore('Northwind', pulled.ledger, context).text).toBe('Northwind');
  });
  it('allows unchanged words shared by the original and replacement', () => {
    const engine = createReplacer([literal('Acme Corp', 'Northwind Corp')]);
    const pulled = engine.anonymize('AcmeCorp', context);
    expect(engine.restore(pulled.text, pulled.ledger, context).text).toBe('AcmeCorp');
  });
});

describe('regex and secret replacements', () => {
  it('records concrete regex pairs including capture groups', () => {
    const engine = createReplacer([
      {
        id: 'services',
        type: 'regex',
        match: 'acme-(\\w+)-svc',
        flags: 'i',
        replace: 'northwind-$1-svc',
      },
    ]);
    const pulled = engine.anonymize('acme-billing-svc acme-auth-svc', context);
    expect(pulled.text).toBe('northwind-billing-svc northwind-auth-svc');
    expect(pulled.ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          original: 'acme-billing-svc',
          anonymized: 'northwind-billing-svc',
        }),
      ]),
    );
    expect(engine.restore(pulled.text, pulled.ledger, context).text).toBe(
      'acme-billing-svc acme-auth-svc',
    );
  });
  it('supports named groups and standard capture substitution tokens', () => {
    const engine = createReplacer([
      {
        id: 'named',
        type: 'regex',
        match: 'acme-(?<service>\\w+)',
        replace: 'northwind-$<service>-$$-$&',
      },
    ]);
    const pulled = engine.anonymize('acme-billing', context);
    expect(pulled.text).toBe('northwind-billing-$-acme-billing');
    expect(engine.restore(pulled.text, pulled.ledger, context).text).toBe('acme-billing');
  });
  it('redacts repeated secrets consistently across files and restores exactly', () => {
    const engine = createReplacer([{ id: 'keys', type: 'secret', detector: 'aws-access-key' }]);
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const first = engine.anonymize(`key=${secret} ${secret}`, context);
    expect(first.text).toBe('key=REDACTED_AWS_ACCESS_KEY_1 REDACTED_AWS_ACCESS_KEY_1');
    const second = engine.anonymize(secret, { ...context, file: 'other.ts' }, first.ledger);
    expect(second.text).toBe('REDACTED_AWS_ACCESS_KEY_1');
    expect(second.ledger).toHaveLength(1);
    expect(engine.restore(first.text, first.ledger, context).text).toBe(`key=${secret} ${secret}`);
    expect(JSON.stringify(first.preview)).not.toContain(secret);
  });
  it('refuses unknown or altered secret placeholders', () => {
    const engine = createReplacer([{ id: 'keys', type: 'secret', detector: 'aws-access-key' }]);
    expect(() => engine.restore('REDACTED_AWS_ACCESS_KEY_7', [], context)).toThrow(/placeholder/i);
    const pulled = engine.anonymize('AKIAIOSFODNN7EXAMPLE', context);
    expect(() => engine.restore(`${pulled.text}x`, pulled.ledger, context)).toThrow(/placeholder/i);
  });
  it('does not run regex replacements over generated literal output', () => {
    const engine = createReplacer([
      literal(),
      { id: 'regex', type: 'regex', match: 'Northwind', replace: 'Zephyr' },
    ]);
    expect(engine.anonymize('Acme', context).text).toBe('Northwind');
  });
  it('refuses empty matches, empty replacements and invalid detectors', () => {
    expect(() => createReplacer([{ id: 'bad', type: 'secret', detector: 'unknown' }])).toThrow(
      /bad.*unknown/,
    );
    expect(() =>
      createReplacer([{ id: 'empty', type: 'regex', match: 'a*', replace: 'x' }]).anonymize(
        'b',
        context,
      ),
    ).toThrow(/empty/);
    expect(() =>
      createReplacer([{ id: 'empty', type: 'regex', match: 'acme', replace: '' }]).anonymize(
        'acme',
        context,
      ),
    ).toThrow(/empty/);
  });
  it('fails rather than partially redacting a secret overlapped by a literal', () => {
    const engine = createReplacer([
      literal('AKIA', 'Zephyr', { boundary: 'anywhere' }),
      { id: 'keys', type: 'secret', detector: 'aws-access-key' },
    ]);
    expect(() => engine.anonymize('AKIAIOSFODNN7EXAMPLE', context)).toThrow(/overlap/);
  });
});

it('keeps matching deterministic across many rules and repeated calls', () => {
  const rules: Rule[] = Array.from({ length: 200 }, (_, index) => ({
    id: `rule-${index}`,
    type: 'literal',
    match: `Company${index}`,
    replace: `Codename${index}`,
  }));
  const engine = createReplacer(rules);
  const source = rules
    .map((rule) => (rule.type === 'literal' ? `get${rule.match}Client` : ''))
    .join('\r\n');
  const first = engine.anonymize(source);
  expect(first.text).toContain('getCodename199Client');
  expect(first.text).not.toContain('Company');
  expect(engine.anonymize(source)).toEqual(first);
  expect(engine.restore(first.text, first.ledger).text).toBe(source);
});

it('uses fixed canonical styles when word counts differ', () => {
  const engine = createReplacer([
    { id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind Traders' },
  ]);
  const result = engine.anonymize('Acme acme ACME');
  expect(result.text).toBe('NorthwindTraders northwindtraders NORTHWINDTRADERS');
  expect(engine.restore(result.text, result.ledger).text).toBe('Acme acme ACME');
});

it('supports Unicode identifiers on both sides of a match', () => {
  const engine = createReplacer([
    { id: 'company', type: 'literal', match: 'Müller', replace: 'Nordwind' },
  ]);
  const source = 'getMüllerToken MÜLLER_API müller-service Mu\u0308ller';
  // A single ledger cannot invert two distinct Unicode spellings to one output.
  expect(() => engine.anonymize(source)).toThrow(/ambiguous/);
  const result = engine.anonymize('getMüllerToken MÜLLER_API müller-service');
  expect(result.text).toBe('getNordwindToken NORDWIND_API nordwind-service');
  expect(engine.restore(result.text, result.ledger).text).toBe(
    'getMüllerToken MÜLLER_API müller-service',
  );
});

it('detects mixed Unicode casing in residues without a large regex', () => {
  const engine = createReplacer([
    { id: 'name', type: 'literal', match: 'Müller', replace: 'Straße' },
  ]);
  expect(() =>
    engine.restore('line one\nsTrAsSe', [], { file: 'example.ts', scope: 'content' }),
  ).toThrow(/example.ts:2.*anonymized/);
});
