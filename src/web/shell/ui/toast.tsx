import { signal } from '@preact/signals';

export type ToastTone = 'info' | 'ok' | 'error';
export type ToastEntry = { id: number; message: string; tone: ToastTone };

export const toasts = signal<ToastEntry[]>([]);
let nextId = 1;

export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((entry) => entry.id !== id);
}
export function toast(message: string, tone: ToastTone = 'info', timeoutMs = 6000) {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, message, tone }];
  // Errors stay until dismissed so they cannot be missed.
  if (tone !== 'error') setTimeout(() => dismissToast(id), timeoutMs);
  return id;
}

export function ToastHost() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((entry) => (
        <div key={entry.id} class={`toast toast-${entry.tone}`}>
          <span>{entry.message}</span>
          <button
            type="button"
            class="toast-close"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(entry.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
