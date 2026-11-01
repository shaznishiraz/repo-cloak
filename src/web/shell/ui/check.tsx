import type { ComponentChildren, ComponentProps } from 'preact';

type Props = Omit<ComponentProps<'input'>, 'type' | 'role'> & {
  label: ComponentChildren;
};

export function Checkbox({ label, ...input }: Props) {
  return (
    <label class="check">
      <input type="checkbox" {...input} />
      <span>{label}</span>
    </label>
  );
}

export function Radio({ label, ...input }: Props) {
  return (
    <label class="check">
      <input type="radio" {...input} />
      <span>{label}</span>
    </label>
  );
}
