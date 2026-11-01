import { expect, it } from 'vitest';
import { firstRunPresets, profilePresets } from '../../src/core/exclusion-presets.js';
import { patternProblem } from '../../src/core/patterns.js';

it('keeps the first-run ids that are stored in the Never pull profile', () => {
  expect(firstRunPresets.map((preset) => preset.id)).toEqual([
    'schemas',
    'lockfiles',
    'env',
    'keys',
  ]);
});

it('shares one definition where both screens offer the same preset', () => {
  const lockfiles = (list: typeof firstRunPresets) => list.find((item) => item.id === 'lockfiles');
  expect(lockfiles(firstRunPresets)).toBe(lockfiles(profilePresets));
});

it('holds only valid patterns', () => {
  for (const preset of [...firstRunPresets, ...profilePresets])
    for (const pattern of preset.patterns) expect(patternProblem(pattern)).toBeUndefined();
});
