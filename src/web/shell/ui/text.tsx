import type { ComponentChildren } from 'preact';

export function Mono({ children, muted }: { children: ComponentChildren; muted?: boolean }) {
  return <span class={muted ? 'mono mono-muted' : 'mono'}>{children}</span>;
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="kbd">{children}</kbd>;
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ComponentChildren;
  action?: ComponentChildren;
}) {
  return (
    <div class="empty">
      <h2 class="empty-title">{title}</h2>
      {children && <p class="empty-body">{children}</p>}
      {action}
    </div>
  );
}
