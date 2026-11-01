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
  {
    id: 'connection-string-password',
    name: 'Connection string password',
    pattern: /(?<![\w.])(?:password|pwd)=(?<secret>[^;\s"'`$<{%()][^;\s"'`()]{5,})(?=[;\s"'`]|$)/im,
    entropy: 2.5,
  },
  {
    id: 'env-password',
    name: 'Password or secret variable',
    pattern:
      /\b[A-Z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET)\s*[=:]\s*["']?(?!process\.env|os\.environ)(?<secret>[^\s"'`;$<{%()][^\s"'`;()]{5,})/,
    entropy: 2.5,
  },
  {
    id: 'short-password',
    name: 'Short quoted password',
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*["'](?<secret>[^\s"']{6,11})["']/i,
    entropy: 2.5,
  },
  {
    id: 'client-secret',
    name: 'OAuth client secret',
    pattern:
      /\b(?:client|app|consumer)[_-]?secret["']?\s*[:=]\s*["']?(?<secret>[A-Za-z0-9_~.+/=-]{16,})/i,
    entropy: 3,
  },
  {
    id: 'azure-storage-key',
    name: 'Azure storage account key',
    pattern: /\bAccountKey=(?<secret>[A-Za-z0-9+/]{40,}={0,2})/,
  },
  {
    id: 'azure-sas',
    name: 'Azure SAS signature',
    pattern: /[?&]sig=(?<secret>[A-Za-z0-9%+/=_-]{20,})/,
  },
  {
    id: 'openai-key',
    name: 'OpenAI API key',
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/,
  },
  {
    id: 'anthropic-key',
    name: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/,
  },
  { id: 'gitlab-token', name: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { id: 'npm-token', name: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/ },
  {
    id: 'sendgrid-key',
    name: 'SendGrid API key',
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  },
  {
    id: 'url-password',
    name: 'Password in a URL',
    pattern: /\b(?:https?|ftp|ssh|git):\/\/[^/\s:@]+:(?<secret>[^@\s/$<{]+)@/i,
    entropy: 2,
  },
];

export function getSecretDetector(id: string): SecretDetector {
  const detector = secretDetectors.find((detector) => detector.id === id);
  if (!detector) throw new Error(`Unknown secret detector ${id}`);
  return detector;
}

/** Names of the detectors that match. Never returns a value, which must not travel. */
export function detectSecretNames(text: string): string[] {
  const names: string[] = [];
  for (const detector of secretDetectors) {
    const flags = detector.pattern.flags.includes('g')
      ? detector.pattern.flags
      : `${detector.pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(detector.pattern.source, flags))) {
      const value = match.groups?.secret ?? match[0];
      if (!detector.entropy || entropy(value) >= detector.entropy) {
        names.push(detector.name);
        break;
      }
    }
  }
  return names;
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
