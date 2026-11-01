import type { Ledger } from '../../../core/ledger.js';
import type { DiffLine } from '../../../web/api/contracts.js';

export function linesOf(text: string) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
type DiffOp = { kind: DiffLine['kind']; before: number; after: number };
/** Longest common subsequence after trimming; huge middles degrade to one replaced block. */
export function diffLines(before: string[], after: string[]): DiffOp[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endA = before.length;
  let endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: 'context', before: i, after: i });
  const rows = endA - start;
  const columns = endB - start;
  if (rows * columns > 4_000_000) {
    for (let i = start; i < endA; i++) ops.push({ kind: 'remove', before: i, after: start });
    for (let j = start; j < endB; j++) ops.push({ kind: 'add', before: endA, after: j });
  } else {
    const width = columns + 1;
    const table = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--)
      for (let j = columns - 1; j >= 0; j--)
        table[i * width + j] =
          before[start + i] === after[start + j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    let i = 0;
    let j = 0;
    while (i < rows || j < columns) {
      if (i < rows && j < columns && before[start + i] === after[start + j]) {
        ops.push({ kind: 'context', before: start + i, after: start + j });
        i++;
        j++;
      } else if (
        j < columns &&
        (i === rows || (table[i * width + j + 1] ?? 0) > (table[(i + 1) * width + j] ?? 0))
      ) {
        ops.push({ kind: 'add', before: start + i, after: start + j });
        j++;
      } else {
        ops.push({ kind: 'remove', before: start + i, after: start + j });
        i++;
      }
    }
  }
  for (let i = endA, j = endB; i < before.length; i++, j++)
    ops.push({ kind: 'context', before: i, after: j });
  return ops;
}
export function changedRange(before: string, after: string) {
  const lines = diffLines(linesOf(before), linesOf(after))
    .filter((op) => op.kind !== 'context')
    .map((op) => op.after + 1);
  if (!lines.length) return undefined;
  const [first, last] = [Math.min(...lines), Math.max(...lines)];
  return first === last ? `line ${first}` : `lines ${first}–${last}`;
}
/** Diffs never show real secrets: what restores from a placeholder stays masked on screen. */
export function maskSecrets(text: string, ledger: Ledger) {
  let masked = text;
  for (const entry of ledger)
    if (entry.kind === 'secret' && entry.scope === 'content')
      masked = masked.replaceAll(entry.original, '[secret]');
  return masked;
}
export function wordAround(text: string, start: number, end: number) {
  const word = /[\p{L}\p{N}_]/u;
  let from = start;
  let to = end;
  while (from > 0 && word.test(text[from - 1] ?? '')) from--;
  while (to < text.length && word.test(text[to] ?? '')) to++;
  return text.slice(from, to);
}
