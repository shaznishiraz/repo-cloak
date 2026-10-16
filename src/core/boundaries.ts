export type Boundary = 'token' | 'word' | 'anywhere';
const word = /[\p{L}\p{N}\p{M}]/u;
const lower = /\p{Ll}/u;
const upper = /\p{Lu}/u;
const digit = /\p{N}/u;
function before(text: string, index: number): string {
  return [...text.slice(Math.max(0, index - 2), index)].at(-1) ?? '';
}
function after(text: string, index: number): string {
  const code = text.codePointAt(index);
  return code === undefined ? '' : String.fromCodePoint(code);
}
function edge(text: string, index: number, mode: Boundary): boolean {
  const left = before(text, index);
  const right = after(text, index);
  if (!word.test(left) || !word.test(right)) return true;
  if (mode === 'word') return false;
  if (digit.test(left) !== digit.test(right)) return true;
  if (lower.test(left) && upper.test(right)) return true;
  return upper.test(left) && upper.test(right) && lower.test(after(text, index + right.length));
}
export function hasBoundary(text: string, start: number, end: number, mode: Boundary): boolean {
  if (mode === 'anywhere') return true;
  if (!edge(text, start, mode)) return false;
  if (edge(text, end, mode)) return true;
  if (mode === 'word') return false;
  return ['s', 'es', "'s"].some(
    (suffix) =>
      text.slice(end, end + suffix.length).toLowerCase() === suffix &&
      edge(text, end + suffix.length, mode),
  );
}
export function isExcepted(
  text: string,
  start: number,
  end: number,
  exceptions: string[],
): boolean {
  return exceptions.some((exception) => {
    const value = exception.normalize('NFC');
    let index = text.indexOf(value, Math.max(0, start - value.length + 1));
    while (index >= 0 && index <= start) {
      if (index + value.length >= end) return true;
      index = text.indexOf(value, index + 1);
    }
    return false;
  });
}
