// @vitest-environment happy-dom
import { render } from 'preact';
import type { ComponentChildren } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Kbd,
  Menu,
  Mono,
  Panel,
  Radio,
  Row,
  RowList,
  SplitButton,
  Tabs,
  ToastHost,
  dismissToast,
  toast,
  toasts,
} from '../../src/web/shell/ui/index.js';

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  toasts.value = [];
});
const show = (node: ComponentChildren) => act(() => render(node, root));
const press = (element: Element | null, key: string) =>
  act(() => {
    element?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });

it.each(['primary', 'secondary', 'ghost', 'danger'] as const)(
  'renders a real %s button that never submits forms',
  (variant) => {
    show(<Button variant={variant}>Go</Button>);
    const button = root.querySelector('button');
    expect(button?.className).toContain(`btn-${variant}`);
    expect(button?.getAttribute('type')).toBe('button');
  },
);

it('names icon buttons for assistive technology', () => {
  show(<IconButton label="Close">×</IconButton>);
  expect(root.querySelector('button')?.getAttribute('aria-label')).toBe('Close');
});

it('splits a primary action from its target menu', () => {
  const run = vi.fn();
  const other = vi.fn();
  show(
    <SplitButton
      label="Push"
      menuLabel="Push target"
      onClick={run}
      items={[{ label: 'Main checkout', onSelect: other }]}
    />,
  );
  const [main, caret] = root.querySelectorAll<HTMLButtonElement>('button');
  act(() => main?.click());
  expect(run).toHaveBeenCalledOnce();
  expect(caret?.getAttribute('aria-label')).toBe('Push target');
  act(() => caret?.click());
  act(() => root.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click());
  expect(other).toHaveBeenCalledOnce();
  expect(root.querySelector('[role="menu"]')).toBeNull();
});

it('drives menus from the keyboard and closes on Escape', () => {
  show(
    <Menu
      label="Actions"
      trigger="Open"
      items={[
        { label: 'One', onSelect: () => {} },
        { label: 'Off', disabled: true, onSelect: () => {} },
        { label: 'Two', onSelect: () => {} },
      ]}
    />,
  );
  const trigger = root.querySelector('button');
  act(() => trigger?.click());
  expect(trigger?.getAttribute('aria-expanded')).toBe('true');
  const menu = root.querySelector('[role="menu"]');
  expect(document.activeElement?.textContent).toContain('One');
  press(menu, 'ArrowDown');
  expect(document.activeElement?.textContent).toContain('Two');
  press(menu, 'ArrowDown');
  expect(document.activeElement?.textContent).toContain('One');
  press(menu, 'Escape');
  expect(root.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('always pairs badge colour with text', () => {
  show(<Badge tone="push">↑4 to push</Badge>);
  const badge = root.querySelector('.badge-push');
  expect(badge?.textContent).toBe('↑4 to push');
});

it('renders panels with a heading and actions', () => {
  show(
    <Panel title="Guard checks" actions={<Button>Run</Button>}>
      body
    </Panel>,
  );
  expect(root.querySelector('h2')?.textContent).toBe('Guard checks');
  expect(root.querySelector('.panel-body')?.textContent).toBe('body');
});

it('marks the selected row and keeps rows as real buttons', () => {
  const pick = vi.fn();
  show(
    <RowList label="Workspaces">
      <Row selected onSelect={pick}>
        one
      </Row>
      <Row onSelect={pick}>two</Row>
      <Row>static</Row>
    </RowList>,
  );
  const rows = root.querySelectorAll('button.row');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.getAttribute('aria-current')).toBe('true');
  expect(rows[0]?.className).toContain('row-selected');
  expect(rows[1]?.hasAttribute('aria-current')).toBe(false);
  expect(root.querySelector('ul')?.getAttribute('aria-label')).toBe('Workspaces');
});

it('moves tabs with the arrow keys and exposes the selection', () => {
  const change = vi.fn();
  const tabs = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  show(<Tabs label="Mode" segmented tabs={tabs} value="a" onChange={change} />);
  expect(root.querySelector('[role="tablist"]')?.className).toContain('tabs-segmented');
  expect(root.querySelector('[data-tab="a"]')?.getAttribute('aria-selected')).toBe('true');
  press(root.querySelector('[role="tablist"]'), 'ArrowLeft');
  expect(change).toHaveBeenCalledWith('b');
});

it('links fields to their label and error', () => {
  show(<Field label="Name" error="Required" value="" />);
  const input = root.querySelector('input');
  const label = root.querySelector('label');
  expect(label?.getAttribute('for')).toBe(input?.id);
  expect(input?.getAttribute('aria-invalid')).toBe('true');
  const note = root.querySelector(`[id="${input?.getAttribute('aria-describedby')}"]`);
  expect(note?.textContent).toBe('Required');
});

it('accepts a custom control inside a field', () => {
  show(<Field label="Kind" control={(aria) => <select {...aria} />} />);
  expect(root.querySelector('select')?.id).toBe(root.querySelector('label')?.getAttribute('for'));
});

it('wraps checkbox and radio in their labels', () => {
  show(
    <>
      <Checkbox label="Stop all" />
      <Radio label="Merge" name="mode" />
    </>,
  );
  expect(root.querySelector('label input[type="checkbox"]')).not.toBeNull();
  expect(root.querySelector('label input[type="radio"]')).not.toBeNull();
});

it('opens and closes a native modal dialog', () => {
  const close = vi.fn();
  show(
    <Dialog title="Delete" open onClose={close} actions={<Button>OK</Button>}>
      Sure?
    </Dialog>,
  );
  const dialog = root.querySelector('dialog');
  expect(dialog?.open).toBe(true);
  expect(dialog?.getAttribute('aria-label')).toBe('Delete');
  show(
    <Dialog title="Delete" open={false} onClose={close}>
      Sure?
    </Dialog>,
  );
  expect(root.querySelector('dialog')?.open).toBe(false);
});

it('announces toasts, expires info and keeps errors until dismissed', () => {
  vi.useFakeTimers();
  try {
    show(<ToastHost />);
    expect(root.querySelector('.toasts')?.getAttribute('aria-live')).toBe('polite');
    act(() => void toast('Saved', 'ok', 100));
    act(() => void toast('Failed', 'error'));
    expect(root.textContent).toContain('Saved');
    act(() => void vi.advanceTimersByTime(10_000));
    expect(root.textContent).not.toContain('Saved');
    expect(root.textContent).toContain('Failed');
    act(() => {
      for (const entry of toasts.value) dismissToast(entry.id);
    });
    expect(root.textContent).not.toContain('Failed');
  } finally {
    vi.useRealTimers();
  }
});

it('renders mono, kbd and empty-state text', () => {
  show(
    <EmptyState title="Nothing yet" action={<Button>Create</Button>}>
      <Mono>src/a.ts</Mono> <Kbd>⌘K</Kbd>
    </EmptyState>,
  );
  expect(root.querySelector('.mono')?.textContent).toBe('src/a.ts');
  expect(root.querySelector('kbd')?.textContent).toBe('⌘K');
  expect(root.querySelector('h2')?.textContent).toBe('Nothing yet');
});
