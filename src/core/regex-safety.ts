/**
 * Static screen for catastrophic backtracking. It rejects shapes known to blow up and cannot
 * catch everything, so user regexes also run in a worker with a hard timeout.
 */
const maxLength = 2000;
const maxDepth = 64;
/** A larger bound behaves like no bound at all once it is nested or repeated. */
const loopBound = 100;

type Range = readonly [number, number];
/** Code units an item can start with. `any` covers what this check does not model exactly. */
type Chars = { any: boolean; ranges: Range[] };
type Atom = { kind: 'atom'; chars: Chars };
type Zero = { kind: 'zero'; body: Alternation | undefined };
type Group = { kind: 'group'; body: Alternation };
type Repeat = { kind: 'repeat'; item: Node; min: number; max: number };
type Node = Atom | Zero | Group | Repeat;
type Alternation = Node[][];

const noChars = (): Chars => ({ any: false, ranges: [] });
const anyChars = (): Chars => ({ any: true, ranges: [] });
const single = (code: number): Chars => ({ any: false, ranges: [[code, code]] });
const digits: Range[] = [[48, 57]];
const word: Range[] = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
];
const space: Range[] = [
  [9, 13],
  [32, 32],
  [160, 160],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
function invert(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const result: Range[] = [];
  let next = 0;
  for (const [start, end] of sorted) {
    if (start > next) result.push([next, start - 1]);
    next = Math.max(next, end + 1);
  }
  if (next <= 0x10ffff) result.push([next, 0x10ffff]);
  return result;
}
const classes: Record<string, Range[]> = {
  d: digits,
  D: invert(digits),
  w: word,
  W: invert(word),
  s: space,
  S: invert(space),
};

class Unsupported extends Error {}

function parse(source: string, flags: string): Alternation {
  let at = 0;
  const ignoreCase = flags.includes('i');
  const fold = (chars: Chars): Chars => {
    if (!ignoreCase || chars.any) return chars;
    // Case folding reaches beyond ASCII (K, the Kelvin sign), so anything else stays unknown.
    if (chars.ranges.some(([, end]) => end > 127)) return anyChars();
    const ranges = [...chars.ranges];
    for (const [start, end] of chars.ranges) {
      for (let code = start; code <= end; code++) {
        const char = String.fromCharCode(code);
        ranges.push(
          [char.toLowerCase().charCodeAt(0), char.toLowerCase().charCodeAt(0)],
          [char.toUpperCase().charCodeAt(0), char.toUpperCase().charCodeAt(0)],
        );
      }
    }
    return { any: false, ranges };
  };
  const dot = (): Chars =>
    flags.includes('s')
      ? anyChars()
      : {
          any: false,
          ranges: invert([
            [10, 10],
            [13, 13],
            [0x2028, 0x2029],
          ]),
        };

  function escape(): Chars {
    const char = source[at++];
    if (char === undefined) throw new Unsupported();
    const known = classes[char];
    if (known) return { any: false, ranges: known };
    if (char === 'p' || char === 'P') {
      if (source[at] === '{') at = source.indexOf('}', at) + 1 || source.length;
      return anyChars();
    }
    if (char === 'x' || char === 'u') {
      if (char === 'u' && source[at] === '{' && flags.includes('u')) {
        const end = source.indexOf('}', at);
        if (end < 0) throw new Unsupported();
        const code = Number.parseInt(source.slice(at + 1, end), 16);
        at = end + 1;
        return Number.isNaN(code) ? anyChars() : single(code);
      }
      const size = char === 'x' ? 2 : 4;
      const text = source.slice(at, at + size);
      if (new RegExp(`^[0-9a-fA-F]{${size}}$`).test(text)) {
        at += size;
        return single(Number.parseInt(text, 16));
      }
      return single(char.charCodeAt(0));
    }
    if (char === 'c') {
      at++;
      return anyChars();
    }
    const controls: Record<string, number> = { n: 10, r: 13, t: 9, v: 11, f: 12, '0': 0 };
    const control = controls[char];
    if (control !== undefined) return single(control);
    return single(char.codePointAt(0) ?? 0);
  }

  function characterClass(): Chars {
    const negated = source[at] === '^';
    if (negated) at++;
    const ranges: Range[] = [];
    let unknown = false;
    while (at < source.length && source[at] !== ']') {
      const start = member();
      if (source[at] === '-' && source[at + 1] !== ']' && at + 1 < source.length) {
        at++;
        const end = member();
        const low = start.ranges[0]?.[0];
        const high = end.ranges[0]?.[1];
        if (low === undefined || high === undefined || start.any || end.any) unknown = true;
        else ranges.push([Math.min(low, high), Math.max(low, high)]);
        continue;
      }
      if (start.any) unknown = true;
      ranges.push(...start.ranges);
    }
    if (source[at] !== ']') throw new Unsupported();
    at++;
    if (unknown) return anyChars();
    return { any: false, ranges: negated ? invert(fold({ any: false, ranges }).ranges) : ranges };
  }
  function member(): Chars {
    const char = source[at];
    if (char === '\\') {
      at++;
      if (source[at] === 'b') {
        at++;
        return single(8);
      }
      return escape();
    }
    const code = source.codePointAt(at) ?? 0;
    at += code > 0xffff ? 2 : 1;
    return single(code);
  }

  function alternation(depth: number): Alternation {
    if (depth > maxDepth) throw new Unsupported();
    const branches: Node[][] = [[]];
    while (at < source.length && source[at] !== ')') {
      if (source[at] === '|') {
        at++;
        branches.push([]);
        continue;
      }
      const item = quantified(depth);
      if (item) branches[branches.length - 1]?.push(item);
    }
    return branches;
  }

  function group(depth: number): Node {
    let zero = false;
    if (source[at] === '?') {
      const rest = source.slice(at + 1, at + 3);
      if (rest.startsWith(':')) at += 2;
      else if (rest === '<=' || rest === '<!') {
        zero = true;
        at += 3;
      } else if (rest.startsWith('=') || rest.startsWith('!')) {
        zero = true;
        at += 2;
      } else if (rest.startsWith('<')) {
        const end = source.indexOf('>', at);
        if (end < 0) throw new Unsupported();
        at = end + 1;
      } else {
        // Inline modifiers change case folding and dot in ways this check does not track.
        throw new Unsupported();
      }
    }
    const body = alternation(depth + 1);
    if (source[at] !== ')') throw new Unsupported();
    at++;
    return zero ? { kind: 'zero', body } : { kind: 'group', body };
  }

  function atom(depth: number): Node {
    const char = source[at];
    at++;
    if (char === '(') return group(depth);
    if (char === '[') return { kind: 'atom', chars: fold(characterClass()) };
    if (char === '.') return { kind: 'atom', chars: dot() };
    if (char === '^' || char === '$') return { kind: 'zero', body: undefined };
    if (char === '\\') {
      const next = source[at];
      if (next === 'b' || next === 'B') {
        at++;
        return { kind: 'zero', body: undefined };
      }
      // A backreference can repeat anything, including nothing.
      if (next && /[1-9]/.test(next)) {
        while (/\d/.test(source[at] ?? '')) at++;
        return { kind: 'repeat', item: { kind: 'atom', chars: anyChars() }, min: 0, max: 1 };
      }
      if (next === 'k' && source[at + 1] === '<') {
        at = source.indexOf('>', at) + 1 || source.length;
        return { kind: 'repeat', item: { kind: 'atom', chars: anyChars() }, min: 0, max: 1 };
      }
      return { kind: 'atom', chars: fold(escape()) };
    }
    const code = source.codePointAt(at - 1) ?? 0;
    if (code > 0xffff) at++;
    return { kind: 'atom', chars: fold(single(code)) };
  }

  function quantified(depth: number): Node {
    const item = atom(depth);
    const bounds = quantifier();
    if (!bounds) return item;
    if (source[at] === '?') at++;
    return { kind: 'repeat', item, ...bounds };
  }
  function quantifier(): { min: number; max: number } | undefined {
    const char = source[at];
    if (char === '*' || char === '+' || char === '?') {
      at++;
      return { min: char === '+' ? 1 : 0, max: char === '?' ? 1 : Infinity };
    }
    if (char !== '{') return undefined;
    const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(at));
    if (!match) return undefined;
    at += match[0].length;
    const min = Number(match[1]);
    const max = !match[2] ? min : match[3] ? Number(match[3]) : Infinity;
    return { min, max };
  }

  const result = alternation(0);
  if (at !== source.length) throw new Unsupported();
  return result;
}

const isLoop = (node: Repeat) => node.max >= loopBound;

function overlap(a: Chars, b: Chars): boolean {
  if ((a.any && (b.any || b.ranges.length > 0)) || (b.any && a.ranges.length > 0)) return true;
  return a.ranges.some(([start, end]) =>
    b.ranges.some(([otherStart, otherEnd]) => start <= otherEnd && otherStart <= end),
  );
}
function union(a: Chars, b: Chars): Chars {
  return { any: a.any || b.any, ranges: [...a.ranges, ...b.ranges] };
}
function nullable(node: Node): boolean {
  if (node.kind === 'atom') return false;
  if (node.kind === 'zero') return true;
  if (node.kind === 'group') return node.body.some((branch) => branch.every(nullable));
  return node.min === 0 || nullable(node.item);
}
function sequenceFirst(nodes: readonly Node[]): Chars {
  let chars = noChars();
  for (const node of nodes) {
    chars = union(chars, first(node));
    if (!nullable(node)) break;
  }
  return chars;
}
function first(node: Node): Chars {
  if (node.kind === 'atom') return node.chars;
  if (node.kind === 'zero') return noChars();
  if (node.kind === 'repeat') return first(node.item);
  return node.body.reduce((chars, branch) => union(chars, sequenceFirst(branch)), noChars());
}
/** Whether the item can match texts of different lengths, so a repeat can split text two ways. */
function isVariable(node: Node): boolean {
  if (node.kind === 'atom' || node.kind === 'zero') return false;
  if (node.kind === 'repeat') return node.max > node.min || isVariable(node.item);
  return (
    node.body.some((branch) => branch.some(isVariable)) ||
    new Set(node.body.map((branch) => branch.length)).size > 1
  );
}
function holdsLoop(node: Node): boolean {
  if (node.kind === 'atom') return false;
  if (node.kind === 'zero') return (node.body ?? []).some((branch) => branch.some(holdsLoop));
  if (node.kind === 'group') return node.body.some((branch) => branch.some(holdsLoop));
  return isLoop(node) || holdsLoop(node.item);
}

/** Checks one sequence. `wrap` is what can follow its last item, including a loop's next pass. */
function checkSequence(nodes: readonly Node[], inLoop: boolean, wrap: Chars): string | undefined {
  for (const [index, node] of nodes.entries()) {
    const rest = nodes.slice(index + 1);
    const following = rest.every(nullable) ? union(sequenceFirst(rest), wrap) : sequenceFirst(rest);
    if (inLoop && isVariable(node) && overlap(lastChars(node), following))
      return 'part of a repeated group can match the same text as what follows it';
    if (node.kind === 'repeat' && isLoop(node)) {
      for (const next of rest) {
        if (next.kind === 'repeat' && isLoop(next) && overlap(first(node), first(next)))
          return 'two unbounded quantifiers in a row can match the same text';
        if (!nullable(next)) break;
      }
    }
    const problem = checkNode(node, inLoop, following);
    if (problem) return problem;
  }
  return undefined;
}
/** What the item can end with: the only part that can run into whatever follows it. */
function lastChars(node: Node): Chars {
  if (node.kind === 'atom') return node.chars;
  if (node.kind === 'zero') return noChars();
  if (node.kind === 'repeat') return lastChars(node.item);
  let chars = noChars();
  for (const branch of node.body) {
    for (let index = branch.length - 1; index >= 0; index--) {
      const item = branch[index];
      if (!item) continue;
      chars = union(chars, lastChars(item));
      if (!nullable(item)) break;
    }
  }
  return chars;
}
function checkAlternation(body: Alternation, inLoop: boolean, wrap: Chars): string | undefined {
  if (inLoop) {
    const starts = body.map(sequenceFirst);
    for (const [index, start] of starts.entries())
      for (const other of starts.slice(index + 1))
        if (overlap(start, other))
          return 'alternatives inside a repeated group can match the same text';
  }
  for (const branch of body) {
    const problem = checkSequence(branch, inLoop, wrap);
    if (problem) return problem;
  }
  return undefined;
}
function checkNode(node: Node, inLoop: boolean, following: Chars): string | undefined {
  if (node.kind === 'atom') return undefined;
  if (node.kind === 'zero')
    return node.body ? checkAlternation(node.body, false, noChars()) : undefined;
  if (node.kind === 'group') return checkAlternation(node.body, inLoop, following);
  if (isLoop(node) && holdsLoop(node.item)) return 'an unbounded quantifier is nested in another';
  const loop = inLoop || isLoop(node);
  const wraps = isLoop(node) ? union(first(node.item), following) : following;
  const inner = node.item;
  if (inner.kind === 'group') return checkAlternation(inner.body, loop, wraps);
  return inner.kind === 'repeat' || inner.kind === 'zero'
    ? checkNode(inner, loop, wraps)
    : undefined;
}

/** Why this pattern is refused, or undefined when no known catastrophic shape was found. */
export function regexSafetyProblem(source: string, flags = ''): string | undefined {
  if (source.length > maxLength) return `the pattern is longer than ${maxLength} characters`;
  let tree: Alternation;
  try {
    tree = parse(source, flags);
  } catch {
    return 'the pattern is too complex to check';
  }
  return checkAlternation(tree, false, noChars());
}
