import type { ComponentChildren } from 'preact';

export function RowList({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <ul class="rows" aria-label={label}>
      {children}
    </ul>
  );
}

export function Row({
  selected,
  onSelect,
  children,
}: {
  selected?: boolean;
  onSelect?: () => void;
  children: ComponentChildren;
}) {
  return (
    <li class="row-item">
      {onSelect ? (
        <button
          type="button"
          class={`row${selected ? ' row-selected' : ''}`}
          aria-current={selected ? 'true' : undefined}
          onClick={onSelect}
        >
          {children}
        </button>
      ) : (
        <div class="row">{children}</div>
      )}
    </li>
  );
}
