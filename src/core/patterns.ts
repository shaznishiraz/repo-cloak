import { Minimatch } from 'minimatch';

/**
 * Profile file patterns follow .gitignore conventions, relative to the repository root:
 *   *.schema.json      a name without "/" matches in every folder
 *   generated/         a trailing "/" means a folder and everything in it
 *   /schema.sql        a leading "/" anchors the pattern to the repository root
 *   src/generated/**   a pattern with "/" matches from the repository root
 * A pattern that names a folder also covers the files inside it.
 */
export function normalizePattern(pattern: string): string {
  let glob = pattern.trim();
  while (glob.startsWith('./')) glob = glob.slice(2);
  const anchored = glob.startsWith('/');
  glob = glob.replace(/^\/+/, '');
  const folder = glob.endsWith('/');
  glob = glob.replace(/\/+$/, '');
  if (!anchored && !glob.includes('/')) glob = `**/${glob}`;
  return folder ? `${glob}/**` : glob;
}

/** Returns why a pattern is unusable, or undefined when it is fine. */
export function patternProblem(pattern: string): string | undefined {
  const trimmed = pattern.trim();
  if (!trimmed) return 'pattern cannot be blank';
  if (trimmed !== pattern) return 'remove the spaces around the pattern';
  if (trimmed.startsWith('!'))
    return 'negation is not supported; list the file under include instead';
  if (trimmed.includes('\\')) return 'use "/" as the folder separator';
  if (/^[A-Za-z]:/.test(trimmed) || trimmed.startsWith('//'))
    return 'use a path relative to the repository root';
  if (trimmed.includes('\0')) return 'pattern cannot contain a NUL character';
  if (trimmed.split('/').includes('..')) return 'pattern cannot point outside the repository';
  if (!/[^/.]/.test(trimmed)) return 'pattern must name a file or folder';
  if (!new Minimatch(normalizePattern(trimmed), options).set.length)
    return 'not a valid glob pattern';
  return undefined;
}

const options = { dot: true, nocase: true, nonegate: true, nocomment: true };

/** Compile patterns once into a matcher for repository-relative paths ("/" separated). */
export function compilePatterns(patterns: readonly string[]): (path: string) => boolean {
  const matchers = patterns.flatMap((pattern) => {
    const glob = normalizePattern(pattern);
    const globs = glob.endsWith('/**') ? [glob] : [glob, `${glob}/**`];
    return globs.map((value) => new Minimatch(value, options));
  });
  return (path) => matchers.some((matcher) => matcher.match(path));
}
