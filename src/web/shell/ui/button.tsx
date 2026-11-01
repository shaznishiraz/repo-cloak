import type { ComponentChildren, ComponentProps } from 'preact';
import { Menu } from './menu.js';
import type { MenuItem } from './menu.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonProps = ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: 'normal' | 'small';
};
export function buttonClass(variant: ButtonVariant = 'secondary', size = 'normal') {
  return `btn btn-${variant}${size === 'small' ? ' btn-small' : ''}`;
}

export function Button({ variant, size, class: extra, type, ...props }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      class={`${buttonClass(variant, size)}${extra ? ` ${String(extra)}` : ''}`}
      {...props}
    />
  );
}

/** Icon-only buttons must name themselves, so `label` is required. */
export function IconButton({
  label,
  children,
  ...props
}: ButtonProps & { label: string; children: ComponentChildren }) {
  return (
    <Button variant="ghost" {...props} aria-label={label} title={label}>
      {children}
    </Button>
  );
}

export function SplitButton({
  label,
  menuLabel,
  items,
  variant = 'primary',
  onClick,
  disabled,
}: {
  label: ComponentChildren;
  menuLabel: string;
  items: MenuItem[];
  variant?: ButtonVariant;
  onClick: () => void;
  disabled?: boolean | undefined;
}) {
  return (
    <span class="btn-split">
      <Button variant={variant} onClick={onClick} disabled={disabled}>
        {label}
      </Button>
      <Menu
        items={items}
        label={menuLabel}
        trigger={
          <span aria-hidden="true" class="btn-split-caret">
            ▾
          </span>
        }
        triggerClass={buttonClass(variant)}
        disabled={disabled}
      />
    </span>
  );
}
