import AhoCorasick from 'ahocorasick';
import { foldText, normalizedText } from './text.js';

export type TextMatch<T> = { start: number; end: number; value: T };

export function createMatcher<T>(
  entries: { text: string; value: T }[],
  options: { foldCase?: boolean } = {},
) {
  const values = new Map<string, T[]>();
  for (const entry of entries) {
    const text = options.foldCase ? foldText(entry.text) : entry.text.normalize('NFC');
    if (!text) throw new Error('Matcher terms cannot be empty');
    const list = values.get(text) ?? [];
    list.push(entry.value);
    values.set(text, list);
  }
  const matcher = values.size ? new AhoCorasick([...values.keys()]) : undefined;
  return {
    search(input: string): TextMatch<T>[] {
      if (!matcher) return [];
      const view = normalizedText(input, options.foldCase);
      const matches: TextMatch<T>[] = [];
      for (const [last, terms] of matcher.search(view.text)) {
        for (const term of terms) {
          const range = view.range(last - term.length + 1, last + 1);
          if (range) for (const value of values.get(term) ?? []) matches.push({ ...range, value });
        }
      }
      return matches;
    },
  };
}

/** Leftmost start wins, then longest match, then stable input order. */
export function selectMatches<T extends { start: number; end: number }>(matches: T[]) {
  const accepted: T[] = [];
  const skipped: T[] = [];
  let end = -1;
  for (const match of [...matches].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (match.start < end) skipped.push(match);
    else {
      accepted.push(match);
      end = match.end;
    }
  }
  return { accepted, skipped };
}
