export type Tab<T extends string> = { id: T; label: string };

/** Tabs and segmented controls share behaviour; `segmented` only changes the look. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  segmented,
}: {
  tabs: Tab<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  segmented?: boolean;
}) {
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const at = tabs.findIndex((tab) => tab.id === value);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(at + step + tabs.length) % tabs.length];
    if (!next) return;
    onChange(next.id);
    (event.currentTarget as HTMLElement)
      .querySelector<HTMLElement>(`[data-tab="${next.id}"]`)
      ?.focus();
  }
  return (
    <div
      class={segmented ? 'tabs tabs-segmented' : 'tabs'}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          class="tab"
          data-tab={tab.id}
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
