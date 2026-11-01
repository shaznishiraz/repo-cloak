import { computed, signal } from '@preact/signals';

export type Command = {
  id: string;
  group: string;
  title: string;
  subtitle?: string;
  /** One glyph shown before the title. */
  icon?: string;
  keywords?: string[];
  /** The equivalent `repo-cloak ...` command; the palette can copy it. */
  cli?: string;
  run: () => void;
  /** ⇧↵: the same action with its options shown first. */
  runWithOptions?: () => void;
};
export type CommandSource = () => Command[];

const sources = signal<CommandSource[]>([]);

/** Screens add commands here; call the returned function when the screen unmounts. */
export function registerCommands(source: CommandSource): () => void {
  sources.value = [...sources.value, source];
  return () => {
    sources.value = sources.value.filter((entry) => entry !== source);
  };
}
export const commands = computed(() => sources.value.flatMap((source) => source()));

/** Every query word must appear somewhere in the command's text. */
export function searchCommands(query: string, list: Command[]): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter((command) => {
    const text = [command.title, command.subtitle, command.group, ...(command.keywords ?? [])]
      .join(' ')
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function groupCommands(list: Command[]): { name: string; items: Command[] }[] {
  const groups = new Map<string, Command[]>();
  for (const command of list)
    groups.set(command.group, [...(groups.get(command.group) ?? []), command]);
  return [...groups].map(([name, items]) => ({ name, items }));
}
