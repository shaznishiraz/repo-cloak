import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export type MenuItem = {
  label: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export function Menu({
  items,
  label,
  trigger,
  triggerClass = 'btn btn-secondary',
  disabled,
}: {
  items: MenuItem[];
  label: string;
  trigger: ComponentChildren;
  triggerClass?: string;
  disabled?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const away = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  function close() {
    setOpen(false);
    button.current?.focus();
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const entries = [
      ...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []),
    ];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    entries[(at + step + entries.length) % entries.length]?.focus();
  }
  return (
    <span class="menu" ref={root}>
      <button
        ref={button}
        type="button"
        class={triggerClass}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div ref={list} class="menu-list" role="menu" aria-label={label} onKeyDown={onKeyDown}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              class="menu-item"
              disabled={item.disabled}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              <span class="menu-mark" aria-hidden="true">
                {item.checked ? '✓' : ''}
              </span>
              <span class="menu-text">
                {item.label}
                {item.hint && <span class="menu-hint">{item.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
