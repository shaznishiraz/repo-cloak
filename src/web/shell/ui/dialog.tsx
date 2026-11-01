import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

/** Native modal dialog: the browser provides the focus trap, Esc and inert background. */
export function Dialog({
  title,
  open,
  onClose,
  children,
  actions,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ComponentChildren;
  actions?: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} class="dialog" aria-label={title} onClose={onClose}>
      <h2 class="dialog-title">{title}</h2>
      <div class="dialog-body">{children}</div>
      {actions && <div class="dialog-actions">{actions}</div>}
    </dialog>
  );
}
