const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** Match normalized names while returning ranges in the untouched input. */
export function foldText(text: string): string {
  text = text.normalize('NFC');
  if (/^\p{ASCII}*$/u.test(text)) return text.toLowerCase();
  return [...text].map((char) => char.toUpperCase().toLowerCase()).join('');
}
export function normalizedText(original: string, foldCase = false) {
  const text = foldCase ? foldText(original) : original.normalize('NFC');
  if (text === original || (foldCase && /^\p{ASCII}*$/u.test(original)))
    return { text, range: (start: number, end: number) => ({ start, end }) };
  const offsets = new Map<number, number>();
  let offset = 0;
  for (const { segment, index } of segmenter.segment(original)) {
    const normalized = foldCase ? foldText(segment) : segment.normalize('NFC');
    offsets.set(offset, index);
    if (normalized === segment)
      for (let i = 1; i < segment.length; i++) offsets.set(offset + i, index + i);
    offset += normalized.length;
    offsets.set(offset, index + segment.length);
  }
  return {
    text,
    range(start: number, end: number) {
      const rawStart = offsets.get(start);
      const rawEnd = offsets.get(end);
      return rawStart === undefined || rawEnd === undefined
        ? undefined
        : { start: rawStart, end: rawEnd };
    },
  };
}

export function location(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  const column = before.length - before.lastIndexOf('\n');
  return { line, column };
}

/** Reuse line offsets for every preview event in a file. Columns use UTF-16. */
export function createLocator(text: string) {
  const lines = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1);
  return (offset: number) => {
    let low = 0;
    let high = lines.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if ((lines[middle] ?? 0) <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - (lines[low] ?? 0) + 1 };
  };
}
