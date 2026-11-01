import { afterEach, expect, it } from 'vitest';
import {
  createBlockingEngine,
  createRegexScan,
  installRegexWorker,
  regexLimits,
} from '../../src/adapters/regex-worker.js';
import { createSyncServices } from '../../src/adapters/sync-services.js';
import { RegexLimitError } from '../../src/core/errors.js';
import { currentRegexEngine, directRun, installRegexEngine } from '../../src/core/regex-engine.js';
import { regexSafetyProblem } from '../../src/core/regex-safety.js';
import { createReplacer } from '../../src/core/replacer.js';
import type { Rule } from '../../src/core/rules.js';

// Passes the static check but runs effectively forever on this input.
const slow = '^(.*?,){14}P';
const slowText = 'a,'.repeat(4000);
const fast = { ...regexLimits, runMs: 300 };
const regexRule = (match: string, replace = 'X$&'): Rule => ({
  id: 'r',
  type: 'regex',
  match,
  replace,
});
const original = currentRegexEngine();
afterEach(() => installRegexEngine(original));

it('the slow pattern gets past the static check, so only the worker can stop it', () => {
  expect(regexSafetyProblem(slow)).toBeUndefined();
});

it('matches the direct engine for captures, groups and flags', () => {
  const run = createBlockingEngine()();
  for (const [source, flags, text] of [
    ['(?<id>a)(b)?', '', 'ab a'],
    ['A', 'i', 'a A'],
    ['^x$', 'm', 'x\nx'],
    ['\\u{1F600}', 'u', 'a\u{1F600}'],
    ['nothing', '', 'text'],
    ['(?:)', '', 'abc'],
  ] as const)
    expect(run(source, flags, text)).toEqual(directRun(source, flags, text));
});

it('stops a slow regex at the hard timeout, naming file and rule', () => {
  const started = performance.now();
  const replacer = createReplacer([regexRule(slow)], createBlockingEngine(fast));
  expect(() => replacer.anonymize(slowText, { file: 'big.txt', scope: 'content' })).toThrow(
    /big\.txt: r: regex did not finish within 0\.3s/,
  );
  expect(performance.now() - started).toBeLessThan(5000);
});

it('stops the static test case (a+)+$ too if it reaches the engine', () => {
  const replacer = createReplacer([regexRule('(a+)+$')], createBlockingEngine(fast));
  expect(() => replacer.anonymize(`${'a'.repeat(40)}!`)).toThrow(RegexLimitError);
});

it('keeps working after a timeout, with a fresh worker', () => {
  const engine = createBlockingEngine(fast);
  expect(() => engine()(slow, '', slowText)).toThrow(RegexLimitError);
  expect(engine()('a', '', 'a')).toHaveLength(1);
});

it('reports a broken pattern as an error, not a timeout', () => {
  const run = createBlockingEngine()();
  expect(() => run('(', '', 'a')).toThrow(/Invalid regular expression/);
  expect(run('a', '', 'a')).toHaveLength(1);
});

it('caps the total time one replacer spends in user regexes', () => {
  const run = createBlockingEngine({ ...fast, sessionMs: 0 })();
  expect(() => run('a', '', 'a')).toThrow(RegexLimitError);
});

it('createSyncServices routes every later replacer through the worker', () => {
  installRegexEngine(() => () => {
    throw new Error('the direct engine was used');
  });
  createSyncServices('/nowhere', {} as never);
  const replacer = createReplacer([regexRule(slow)], undefined);
  const run = currentRegexEngine()();
  expect(run('a', '', 'a')).toHaveLength(1);
  expect(replacer.anonymize('plain').text).toBe('plain');
});

it('installRegexWorker keeps the default engine out of production paths', () => {
  installRegexWorker();
  expect(currentRegexEngine()).not.toBe(original);
});

it('a scan leaves the event loop free while a regex runs, then reports the timeout', async () => {
  const scan = createRegexScan([{ source: slow, flags: '' }], { runMs: 300, scanMs: 5000 });
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  try {
    await expect(scan.prepare(slowText)).rejects.toThrow(/did not finish within 0\.3s/);
  } finally {
    clearInterval(ticker);
    scan.close();
  }
  expect(ticks).toBeGreaterThan(3);
});

it('a scan serves prepared matches to a synchronous replacer', async () => {
  const rule = regexRule('CH-(\\d+)', 'CLM-$1');
  const scan = createRegexScan([{ source: 'CH-(\\d+)', flags: '' }]);
  try {
    const replacer = createReplacer([rule], scan.engine);
    await scan.prepare('see CH-12');
    expect(replacer.anonymize('see CH-12').text).toBe('see CLM-12');
    expect(() => replacer.anonymize('other text')).toThrow(/not prepared/);
  } finally {
    scan.close();
  }
});
