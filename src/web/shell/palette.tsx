import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { commands, groupCommands, searchCommands } from './commands.js';
import type { Command } from './commands.js';
import { toast } from './ui/index.js';

export const paletteOpen = signal(false);
export function openPalette() {
  paletteOpen.value = true;
}
export function closePalette() {
  paletteOpen.value = false;
}

function Results({
  groups,
  active,
  onPick,
  onHover,
}: {
  groups: { name: string; items: Command[] }[];
  active: Command | undefined;
  onPick: (command: Command) => void;
  onHover: (command: Command) => void;
}) {
  return (
    <div id="palette-results" class="palette-results" role="listbox" aria-label="Commands">
      {groups.map((group) => (
        <div key={group.name} role="group" aria-label={group.name}>
          <div class="palette-group" aria-hidden="true">
            {group.name}
          </div>
          {group.items.map((command) => (
            <div
              key={command.id}
              id={`palette-${command.id}`}
              role="option"
              aria-selected={command === active}
              class={command === active ? 'palette-item palette-item-active' : 'palette-item'}
              onClick={() => onPick(command)}
              onMouseMove={() => onHover(command)}
            >
              <span class="palette-icon" aria-hidden="true">
                {command.icon ?? '·'}
              </span>
              <span class="palette-text">
                <span class="palette-title">{command.title}</span>
                {command.subtitle && <span class="palette-subtitle">{command.subtitle}</span>}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Palette() {
  const open = paletteOpen.value;
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | undefined>();
  const matches = open ? searchCommands(query, commands.value) : [];
  const groups = groupCommands(matches);
  // Move through commands in the order they are displayed.
  const ordered = groups.flatMap((group) => group.items);
  const active = ordered.find((command) => command.id === activeId) ?? ordered[0];

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setQuery('');
      setActiveId(undefined);
      element.showModal();
      input.current?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  function run(command: Command | undefined, withOptions = false) {
    if (!command) return;
    closePalette();
    (withOptions ? (command.runWithOptions ?? command.run) : command.run)();
  }
  function copyCli() {
    if (!active?.cli) {
      toast('This command has no CLI equivalent');
      return;
    }
    const cli = active.cli;
    void navigator.clipboard.writeText(cli).then(
      () => toast(`Copied: ${cli}`, 'ok'),
      () => toast('Could not copy to the clipboard', 'error'),
    );
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!ordered.length || !active) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (ordered.indexOf(active) + step + ordered.length) % ordered.length;
      setActiveId(ordered[next]?.id);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(active, event.shiftKey);
    } else if (
      event.key === 'c' &&
      (event.metaKey || event.ctrlKey) &&
      input.current?.selectionStart === input.current?.selectionEnd
    ) {
      event.preventDefault();
      copyCli();
    }
  }
  return (
    <dialog
      ref={dialog}
      class="palette"
      aria-label="Command palette"
      onClose={closePalette}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === dialog.current) closePalette();
      }}
    >
      {open && (
        <>
          <label class="palette-input">
            <span class="palette-prompt" aria-hidden="true">
              ›
            </span>
            <span class="sr-only">Command</span>
            <input
              ref={input}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-results"
              aria-activedescendant={active ? `palette-${active.id}` : undefined}
              autocomplete="off"
              spellcheck={false}
              value={query}
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                setActiveId(undefined);
              }}
            />
            <kbd class="kbd">esc</kbd>
          </label>
          {ordered.length ? (
            <Results
              groups={groups}
              active={active}
              onPick={run}
              onHover={(c) => setActiveId(c.id)}
            />
          ) : (
            <p class="palette-empty">No matching commands</p>
          )}
          <div class="palette-foot">
            <span>↑↓ move</span>
            <span>↵ run</span>
            <span>⇧↵ run with options</span>
            <span>⌘C copy CLI command</span>
          </div>
        </>
      )}
    </dialog>
  );
}
