import { kindLabels, rowOf, setList } from './rules.js';
import type { ProfileDoc, RuleDoc } from './rules.js';

/** Extensions are bookkeeping, so they read last even though the engine stores them first. */
export function pretty(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return JSON.stringify(value, null, 2);
  const { extensions, ...rest } = value as Record<string, unknown>;
  return JSON.stringify(extensions === undefined ? rest : { ...rest, extensions }, null, 2);
}

/** Line of a dotted JSON path (rules.3.replace) in `text`; the nearest parent when it is missing. */
export function lineOfPath(text: string, path: string): number | undefined {
  const lines = new Map<string, number>();
  let at = 0;
  let line = 1;
  const space = () => {
    while (at < text.length && /\s/.test(text.charAt(at))) {
      if (text[at] === '\n') line += 1;
      at += 1;
    }
  };
  const string = () => {
    const start = at;
    at += 1;
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
    at += 1;
    return text.slice(start, at);
  };
  function value(current: string) {
    space();
    lines.set(current, line);
    const char = text[at];
    if (char === '"') string();
    else if (char === '{') {
      at += 1;
      for (;;) {
        space();
        if (text[at] === '}' || at >= text.length) break;
        const key = JSON.parse(string()) as string;
        const child = current ? `${current}.${key}` : key;
        space();
        const keyLine = line;
        at += 1; // the colon
        value(child);
        lines.set(child, keyLine);
        space();
        if (text[at] === ',') at += 1;
      }
      at += 1;
    } else if (char === '[') {
      at += 1;
      for (let index = 0; ; index += 1) {
        space();
        if (text[at] === ']' || at >= text.length) break;
        value(current ? `${current}.${index}` : String(index));
        space();
        if (text[at] === ',') at += 1;
      }
      at += 1;
    } else while (at < text.length && !/[\s,}\]]/.test(text.charAt(at))) at += 1;
  }
  try {
    JSON.parse(text);
    value('');
  } catch {
    return undefined;
  }
  const parts = path ? path.split('.') : [];
  while (parts.length) {
    const found = lines.get(parts.join('.'));
    if (found !== undefined) return found;
    parts.pop();
  }
  return lines.get('');
}

/** Where JSON.parse stopped, for the problems list while the text does not parse. */
export function parseProblem(text: string): { line: number; message: string } | undefined {
  try {
    JSON.parse(text);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    const position = /position (\d+)/.exec(message)?.[1];
    const offset = position === undefined ? text.length : Number(position);
    return {
      line: text.slice(0, offset).split('\n').length,
      message: 'This is not valid JSON yet.',
    };
  }
}

function counts(lines: string[]) {
  const result = new Map<string, number>();
  for (const line of lines) result.set(line, (result.get(line) ?? 0) + 1);
  return result;
}
/** Lines added and removed against the saved text, ignoring moves within the same count. */
export function lineChanges(saved: string, current: string) {
  const old = counts(saved.split('\n'));
  const added = new Set<number>();
  current.split('\n').forEach((line, index) => {
    const left = old.get(line) ?? 0;
    if (left > 0) old.set(line, left - 1);
    else added.add(index + 1);
  });
  let removed = 0;
  for (const left of old.values()) removed += left;
  return { added, removed };
}

export type EditResult = { text: string; start: number; end: number };
function lineSpan(text: string, start: number, end: number) {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const stop = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const next = text.indexOf('\n', stop);
  return { from, to: next < 0 ? text.length : next };
}
/** ⌥↑ / ⌥↓: move the selected lines one line up or down. */
export function moveLines(text: string, start: number, end: number, step: 1 | -1): EditResult {
  const { from, to } = lineSpan(text, start, end);
  const block = text.slice(from, to);
  if (step < 0) {
    if (from === 0) return { text, start, end };
    const above = text.lastIndexOf('\n', from - 2) + 1;
    const moved = `${text.slice(0, above)}${block}\n${text.slice(above, from - 1)}${text.slice(to)}`;
    return { text: moved, start: start - (from - above), end: end - (from - above) };
  }
  if (to === text.length) return { text, start, end };
  const below = text.indexOf('\n', to + 1);
  const stop = below < 0 ? text.length : below;
  const line = text.slice(to + 1, stop);
  const moved = `${text.slice(0, from)}${line}\n${block}${text.slice(stop)}`;
  return { text: moved, start: start + line.length + 1, end: end + line.length + 1 };
}
/** ⌘D: duplicate the selected lines below themselves and select the copy. */
export function duplicateLines(text: string, start: number, end: number): EditResult {
  const { from, to } = lineSpan(text, start, end);
  const block = text.slice(from, to);
  const offset = block.length + 1;
  return {
    text: `${text.slice(0, to)}\n${block}${text.slice(to)}`,
    start: start + offset,
    end: end + offset,
  };
}

export type Outline = {
  rules: number;
  byKind: { label: string; count: number }[];
  exclude: number;
  inherited: number;
  include: number;
};
export function outlineOf(doc: ProfileDoc, inherited: number): Outline {
  const tally = new Map<string, number>();
  for (const rule of doc.rules) {
    const label = kindLabels[rowOf(doc, rule).kind].toLowerCase();
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  return {
    rules: doc.rules.length,
    byKind: [...tally].map(([label, count]) => ({ label, count })),
    exclude: doc.exclude?.length ?? 0,
    inherited,
    include: doc.include?.length ?? 0,
  };
}

/* ---------- Paste from LLM: one acceptable change per difference ---------- */
export type PasteChange = {
  id: string;
  kind: 'added' | 'removed' | 'changed';
  label: string;
  before?: string;
  after?: string;
};
const same = (a: unknown, b: unknown) => pretty(a) === pretty(b);
const describeRule = (rule: RuleDoc) =>
  rule.type === 'secret'
    ? `secret · ${rule.detector ?? ''}`
    : `${rule.match ?? ''} → ${rule.replace ?? ''}`;

export function diffProfiles(current: ProfileDoc, incoming: ProfileDoc): PasteChange[] {
  const changes: PasteChange[] = [];
  for (const key of ['name', 'description'] as const) {
    if (same(current[key] ?? null, incoming[key] ?? null)) continue;
    changes.push({
      id: `field:${key}`,
      kind: 'changed',
      label: key,
      ...(current[key] ? { before: current[key] } : {}),
      ...(incoming[key] ? { after: incoming[key] } : {}),
    });
  }
  const ours = new Map(current.rules.map((rule) => [rule.id, rule]));
  const theirs = new Map(incoming.rules.map((rule) => [rule.id, rule]));
  for (const rule of incoming.rules) {
    const mine = ours.get(rule.id);
    if (!mine)
      changes.push({
        id: `rule:${rule.id}`,
        kind: 'added',
        label: `Rule ${rule.id}`,
        after: describeRule(rule),
      });
    else if (!same(mine, rule))
      changes.push({
        id: `rule:${rule.id}`,
        kind: 'changed',
        label: `Rule ${rule.id}`,
        before: describeRule(mine),
        after: describeRule(rule),
      });
  }
  for (const rule of current.rules)
    if (!theirs.has(rule.id))
      changes.push({
        id: `rule:${rule.id}`,
        kind: 'removed',
        label: `Rule ${rule.id}`,
        before: describeRule(rule),
      });
  for (const key of ['exclude', 'include'] as const) {
    const mine = current[key] ?? [];
    const others = incoming[key] ?? [];
    for (const pattern of others)
      if (!mine.includes(pattern))
        changes.push({ id: `${key}:${pattern}`, kind: 'added', label: key, after: pattern });
    for (const pattern of mine)
      if (!others.includes(pattern))
        changes.push({ id: `${key}:${pattern}`, kind: 'removed', label: key, before: pattern });
  }
  return changes;
}

/** Applies only the accepted differences, leaving everything else as it is in `current`. */
export function applyChanges(
  current: ProfileDoc,
  incoming: ProfileDoc,
  accepted: ReadonlySet<string>,
): ProfileDoc {
  const next: ProfileDoc = structuredClone(current);
  if (accepted.has('field:name')) next.name = incoming.name;
  if (accepted.has('field:description')) {
    if (incoming.description === undefined) delete next.description;
    else next.description = incoming.description;
  }
  const incomingRules = new Map(incoming.rules.map((rule) => [rule.id, rule]));
  const kept: RuleDoc[] = [];
  for (const rule of next.rules) {
    const accept = accepted.has(`rule:${rule.id}`);
    const other = incomingRules.get(rule.id);
    if (!accept) kept.push(rule);
    else if (other) kept.push(structuredClone(other));
  }
  for (const rule of incoming.rules)
    if (accepted.has(`rule:${rule.id}`) && !next.rules.some((item) => item.id === rule.id))
      kept.push(structuredClone(rule));
  next.rules = kept;
  let result = next;
  for (const key of ['exclude', 'include'] as const) {
    const mine = next[key] ?? [];
    const others = incoming[key] ?? [];
    const taken = (item: string) => accepted.has(`${key}:${item}`);
    result = setList(result, key, [
      ...mine.filter((item) => !taken(item) || others.includes(item)),
      ...others.filter((item) => taken(item) && !mine.includes(item)),
    ]);
  }
  const labels = incoming.extensions?.ruleKinds;
  if (labels && typeof labels === 'object') {
    const merged: Record<string, unknown> = {
      ...((result.extensions?.ruleKinds as Record<string, unknown> | undefined) ?? {}),
    };
    for (const [id, value] of Object.entries(labels))
      if (accepted.has(`rule:${id}`)) merged[id] = value;
    if (Object.keys(merged).length)
      result = { ...result, extensions: { ...(result.extensions ?? {}), ruleKinds: merged } };
  }
  return result;
}
