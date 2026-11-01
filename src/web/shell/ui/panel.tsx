import type { ComponentChildren } from 'preact';

export function Panel({
  title,
  actions,
  children,
}: {
  title: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="panel">
      <header class="panel-head">
        <h2 class="panel-title">{title}</h2>
        {actions && <div class="panel-actions">{actions}</div>}
      </header>
      <div class="panel-body">{children}</div>
    </section>
  );
}
