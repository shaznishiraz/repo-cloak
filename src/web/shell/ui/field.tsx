import type { ComponentChildren, ComponentProps } from 'preact';
import { useId } from 'preact/hooks';

type InputProps = ComponentProps<'input'>;
export type ControlProps = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };

/** Labelled control. Renders an input by default; pass `control` for a select or textarea. */
export function Field({
  label,
  hint,
  error,
  control,
  ...input
}: InputProps & {
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string | undefined;
  control?: (props: ControlProps) => ComponentChildren;
}) {
  const id = useId();
  const noteId = hint || error ? `${id}-note` : undefined;
  const aria: ControlProps = {
    id,
    ...(noteId ? { 'aria-describedby': noteId } : {}),
    ...(error ? { 'aria-invalid': true } : {}),
  };
  return (
    <div class="field">
      <label class="field-label" for={id}>
        {label}
      </label>
      {control ? control(aria) : <input class="input" type="text" {...input} {...aria} />}
      {noteId && (
        <span id={noteId} class={error ? 'field-error' : 'field-hint'}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
}
