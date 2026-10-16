export type SecretDetector = { id: string; name: string; pattern: RegExp; entropy?: number };

// Patterns are data, scanned once per file. Assignment detectors capture only
// the value; PEM and URL detectors replace the whole sensitive block.
export const secretDetectors: readonly SecretDetector[] = [
  {
    id: 'aws-access-key',
    name: 'AWS access key',
    pattern:
      /(?<![A-Za-z0-9_])(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9_])/,
  },
  {
    id: 'aws-secret-key',
    name: 'AWS secret key',
    pattern:
      /\baws_(?:secret_)?(?:access_)?key\s*[:=]\s*["']?(?<secret>[A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i,
  },
  {
    id: 'private-key',
    name: 'Private key',
    pattern:
      /-----BEGIN (?<format>(?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?)PRIVATE KEY-----[\s\S]+?-----END \k<format>PRIVATE KEY-----/,
  },
  {
    id: 'api-key',
    name: 'API key or token',
    pattern:
      /\b(?:api_?key|auth_?token|access_?token|secret_?key|bearer_?token)\s*[:=]\s*["']?(?<secret>[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/i,
    entropy: 3,
  },
  {
    id: 'password',
    name: 'Password',
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*["'](?<secret>[^\s"']{12,})["']/i,
    entropy: 3,
  },
  {
    id: 'jwt',
    name: 'JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/,
  },
  {
    id: 'github-token',
    name: 'GitHub token',
    pattern:
      /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})(?![A-Za-z0-9_])/,
  },
  {
    id: 'slack-token',
    name: 'Slack token',
    pattern:
      /\bxox[pboars]-[0-9]{10,13}-[0-9]{10,13}-(?:[0-9]{10,13}-)?[A-Za-z0-9]{24,64}(?![A-Za-z0-9])/,
  },
  {
    id: 'slack-webhook',
    name: 'Slack webhook',
    pattern:
      /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]{8,}\/B[A-Za-z0-9_]{8,}\/[A-Za-z0-9_]{24,}/,
  },
  {
    id: 'stripe-key',
    name: 'Stripe key',
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}(?![A-Za-z0-9])/,
  },
  {
    id: 'google-api-key',
    name: 'Google API key',
    pattern: /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/,
  },
  {
    id: 'google-oauth-token',
    name: 'Google OAuth token',
    pattern: /\bya29\.[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/,
  },
  {
    id: 'discord-token',
    name: 'Discord bot token',
    pattern: /\b[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}(?![A-Za-z0-9_-])/,
  },
  {
    id: 'discord-webhook',
    name: 'Discord webhook',
    pattern: /https:\/\/discord\.com\/api\/webhooks\/[0-9]{18,19}\/[A-Za-z0-9_-]{68,}/,
  },
  {
    id: 'database-url',
    name: 'Database connection URL',
    pattern:
      /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|mssql|redis|amqps?):\/\/[^/\s:@]+:[^@\s]+@[^\s"'`]+/i,
  },
  {
    id: 'heroku-key',
    name: 'Heroku API key',
    pattern:
      /\bheroku[_-]?(?:api[_-]?)?key\s*[:=]\s*["']?(?<secret>[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12})(?![A-Fa-f0-9])/i,
  },
  { id: 'mailgun-key', name: 'Mailgun API key', pattern: /\bkey-[A-Fa-f0-9]{32}(?![A-Fa-f0-9])/ },
];

export function getSecretDetector(id: string): SecretDetector {
  const detector = secretDetectors.find((detector) => detector.id === id);
  if (!detector) throw new Error(`Unknown secret detector ${id}`);
  return detector;
}

export function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  const length = [...text].length;
  let result = 0;
  for (const count of counts.values()) {
    const frequency = count / length;
    result -= frequency * Math.log2(frequency);
  }
  return result;
}
