import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(resolve('src/web/tokens.css'), 'utf8');
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`).exec(css);
  if (!match?.[1]) throw new Error(`Missing token ${name}`);
  return match[1];
}
function luminance(hex: string) {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

it('lifts the design palette verbatim', () => {
  expect(token('ground')).toBe('#0d0e10');
  expect(token('topbar')).toBe('#111215');
});

it.each([
  ['text', 'ground'],
  ['text-2', 'panel'],
  ['text-3', 'ground'],
  ['text-3', 'panel'],
  ['text-3', 'raised'],
  ['text-3', 'overlay'],
  ['text-2', 'row-active'],
  ['on-solid', 'text'],
  ['on-solid', 'accent'],
  ['accent', 'panel'],
  ['accent-soft', 'accent-bg'],
  ['push', 'push-bg'],
  ['pull', 'pull-bg'],
  ['ok', 'ok-bg'],
  ['blocked', 'blocked-bg'],
])('%s on %s meets 4.5:1', (foreground, background) => {
  expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(4.5);
});

it('loads no remote fonts or images', () => {
  expect(css).not.toMatch(/url\(|@import|@font-face/);
});
