import type { ComponentChildren } from 'preact';

export type BadgeTone = 'neutral' | 'accent' | 'push' | 'pull' | 'ok' | 'blocked';

/** Status is never colour alone: a badge always carries its text. */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ComponentChildren;
}) {
  return <span class={`badge badge-${tone}`}>{children}</span>;
}
