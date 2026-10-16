import { describe, expect, it } from 'vitest';
import { createReplacer } from '../../src/core/replacer.js';

const samples = [
  ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
  ['aws-secret-key', 'aws_secret_access_key="AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/+=x"'],
  [
    'private-key',
    '-----BEGIN RSA PRIVATE KEY-----\nZmFrZS1rZXktYnl0ZXM=\n-----END RSA PRIVATE KEY-----',
  ],
  ['api-key', 'api_key="AbCdEfGhIjKlMn0123456789"'],
  ['password', 'password="tR7!qP2#sV9@xL4"'],
  ['jwt', 'eyJabcdefghijklm.eyJnopqrstuvwxyz.Abcdef0123456789'],
  ['github-token', `ghp_${'aB09'.repeat(9)}`],
  ['slack-token', `xoxb-123456789012-123456789012-${'aB09'.repeat(8)}`],
  ['slack-webhook', `https://hooks.slack.com/services/T12345678/B12345678/${'aB09'.repeat(6)}`],
  ['stripe-key', `sk_test_${'aB09'.repeat(6)}`],
  ['google-api-key', `AIza${'aB09'.repeat(8)}abc`],
  ['google-oauth-token', `ya29.${'aB09'.repeat(8)}`],
  ['discord-token', `M${'aB09'.repeat(6)}.abcdef.${'aB09'.repeat(7)}`],
  ['discord-webhook', `https://discord.com/api/webhooks/123456789012345678/${'aB09'.repeat(17)}`],
  ['database-url', 'postgresql://user:secret@localhost:5432/example'],
  ['heroku-key', 'heroku_api_key="12345678-abcd-1234-abcd-123456789abc"'],
  ['mailgun-key', `key-${'aB09'.repeat(8)}`],
] as const;

describe('secret detector catalog', () => {
  it.each(samples)('redacts and restores %s', (detector, sample) => {
    const engine = createReplacer([{ id: 'secret', type: 'secret', detector }]);
    const source = `before\r\n${sample}\r\nafter`;
    const pulled = engine.anonymize(source);
    expect(pulled.ledger).toHaveLength(1);
    expect(pulled.text).toContain(`REDACTED_${detector.replaceAll('-', '_').toUpperCase()}_1`);
    expect(engine.restore(pulled.text, pulled.ledger).text).toBe(source);
    expect(JSON.stringify(pulled.preview)).not.toContain(pulled.ledger[0]?.original);
  });
  it('redacts a whole private key and keeps assignment labels unchanged', () => {
    const key = samples.find(([id]) => id === 'private-key')?.[1] ?? '';
    const privateKey = createReplacer([{ id: 'keys', type: 'secret', detector: 'private-key' }]);
    expect(privateKey.anonymize(key).text).toBe('REDACTED_PRIVATE_KEY_1');
    const password = createReplacer([{ id: 'passwords', type: 'secret', detector: 'password' }]);
    expect(password.anonymize('password="tR7!qP2#sV9@xL4"').text).toBe(
      'password="REDACTED_PASSWORD_1"',
    );
    expect(password.anonymize('password="aaaaaaaaaaaaaaaa"').text).toBe(
      'password="aaaaaaaaaaaaaaaa"',
    );
  });
  it('does not mistake a pipe for a Discord token prefix', () => {
    const engine = createReplacer([{ id: 'keys', type: 'secret', detector: 'discord-token' }]);
    const value = `|${'aB09'.repeat(6)}.abcdef.${'aB09'.repeat(7)}`;
    expect(engine.anonymize(value).text).toBe(value);
  });
  it('allocates distinct stable numbers and rejects pre-existing placeholders', () => {
    const engine = createReplacer([{ id: 'keys', type: 'secret', detector: 'aws-access-key' }]);
    const first = engine.anonymize('AKIAIOSFODNN7EXAMPLE');
    const second = engine.anonymize('ASIAIOSFODNN7EXAMPLE', undefined, first.ledger);
    expect(second.text).toBe('REDACTED_AWS_ACCESS_KEY_2');
    expect(() => engine.anonymize('REDACTED_AWS_ACCESS_KEY_2')).toThrow(/already contains/);
  });
  it('does not let a longer regex leave a selected secret exposed', () => {
    const engine = createReplacer([
      { id: 'assignment', type: 'regex', match: 'token=(AKIA[A-Z0-9]{16})', replace: 'value=$1' },
      { id: 'keys', type: 'secret', detector: 'aws-access-key' },
    ]);
    expect(() => engine.anonymize('token=AKIAIOSFODNN7EXAMPLE')).toThrow(/keys.*overlap/);
  });
  it('deduplicates overlapping secret detectors without exposing the original', () => {
    const engine = createReplacer([
      { id: 'specific', type: 'secret', detector: 'github-token' },
      { id: 'generic', type: 'secret', detector: 'api-key' },
    ]);
    const source = `api_key="ghp_${'aB09'.repeat(9)}"`;
    const pulled = engine.anonymize(source);
    expect(pulled.ledger).toHaveLength(1);
    expect(pulled.text).not.toContain('ghp_');
    expect(engine.restore(pulled.text, pulled.ledger).text).toBe(source);
  });
});

it('masks skipped matches that overlap a detected secret, including file names', () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  const engine = createReplacer([
    {
      id: 'partial',
      type: 'literal',
      match: secret.slice(0, -1),
      replace: 'Northwind',
      boundary: 'word',
    },
    { id: 'keys', type: 'secret', detector: 'aws-access-key' },
    { id: 'regex', type: 'regex', match: 'AKIA[A-Z0-9]{16}', replace: 'copy-$&' },
  ]);
  const result = engine.anonymize(secret, { file: `${secret}.txt`, scope: 'content' });
  expect(result.text).toBe('REDACTED_AWS_ACCESS_KEY_1');
  expect(JSON.stringify(result.preview)).not.toContain(secret);
  expect(JSON.stringify(result.preview)).not.toContain(secret.slice(0, -1));
});
