import { createHash } from 'node:crypto';

export function hashBytes(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`;
}
export function hashJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  return hashBytes(Buffer.from(text));
}
