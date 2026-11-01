import { RegexLimitError } from './errors.js';

/** One match, as plain data: it may have crossed a worker boundary. */
export type RegexHit = {
  index: number;
  captures: (string | undefined)[];
  groups?: Record<string, string | undefined>;
};
export type RegexRun = (source: string, flags: string, text: string) => RegexHit[];
/** Called once per replacer, so an engine can budget the whole job. */
export type RegexEngine = () => RegexRun;

/** In-process matching, for pure core use. Stops at an empty match, which core refuses anyway. */
export function directRun(source: string, flags: string, text: string): RegexHit[] {
  const hits: RegexHit[] = [];
  for (const match of text.matchAll(new RegExp(source, `${flags}g`))) {
    hits.push({
      index: match.index,
      captures: [...match],
      ...(match.groups ? { groups: { ...match.groups } } : {}),
    });
    if (!match[0]) break;
  }
  return hits;
}

let installed: RegexEngine = () => directRun;
/** Set once by the composition root. Every replacer made later runs user regexes through it. */
export function installRegexEngine(engine: RegexEngine) {
  installed = engine;
}
export const currentRegexEngine = (): RegexEngine => installed;

export function regexLimitMessage(limitMs: number) {
  return `regex did not finish within ${limitMs / 1000}s; simplify the pattern`;
}
export { RegexLimitError };
