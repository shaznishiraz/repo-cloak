import { isPortableName } from './path-names.js';
import type { Ledger, PreviewMatch } from './ledger.js';
import type { Replacer } from './replacer.js';

export type PathChange = { original: string; anonymized: string };

export function validateRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!isPortableName(segment) || ['.git', '.repo-cloak'].includes(segment.toLowerCase())) {
      throw new Error(`Unsafe path or filename: ${path}`);
    }
  }
  return normalized;
}

export function checkPathCollisions(paths: PathChange[], reverse: boolean): void {
  const nodes = new Map<string, { original: string; file: boolean }>();
  for (const change of paths) {
    const source = (reverse ? change.anonymized : change.original).split('/');
    const target = (reverse ? change.original : change.anonymized).split('/');
    for (let i = 0; i < target.length; i++) {
      const output = target.slice(0, i + 1).join('/');
      const input = source.slice(0, i + 1).join('/');
      const key = output.normalize('NFC').toLowerCase();
      const file = i === target.length - 1;
      const previous = nodes.get(key);
      if (previous && (previous.original !== input || previous.file || file))
        throw new Error(`Path collision: ${previous.original} and ${input}`);
      nodes.set(key, { original: input, file });
    }
  }
}

function transformPaths(
  input: string[],
  replacer: Replacer,
  inputLedger: Ledger,
  reverse: boolean,
) {
  let ledger = inputLedger;
  const paths: PathChange[] = [];
  const preview: PreviewMatch[] = [];
  for (const inputPath of input) {
    const path = validateRelativePath(inputPath);
    const segments: string[] = [];
    for (const segment of path.split('/')) {
      const context = { file: path, scope: 'paths' } as const;
      if (reverse) {
        const result = replacer.restore(segment, ledger, context);
        segments.push(result.text);
        preview.push(...result.preview);
      } else {
        const result = replacer.anonymize(segment, context, ledger);
        ledger = result.ledger;
        segments.push(result.text);
        preview.push(...result.preview);
      }
    }
    const transformed = segments
      .map((segment) => {
        if (segment.includes('/') || segment.includes('\\'))
          throw new Error(`Unsafe replacement in path: ${path}`);
        return segment;
      })
      .join('/');
    validateRelativePath(transformed);
    paths.push(
      reverse
        ? { original: transformed, anonymized: path }
        : { original: path, anonymized: transformed },
    );
  }
  checkPathCollisions(paths, reverse);
  return { paths, ledger, preview };
}

export function anonymizePaths(paths: string[], replacer: Replacer, ledger: Ledger = []) {
  return transformPaths(paths, replacer, ledger, false);
}
export function restorePaths(paths: string[], replacer: Replacer, ledger: Ledger) {
  return transformPaths(paths, replacer, ledger, true);
}
