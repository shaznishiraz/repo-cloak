import { expect, it } from 'vitest';
import { classifyInterrupted } from '../../src/core/push-recovery.js';

const file = (current: string | null, before: string | null = 'b', after: string | null = 'a') => ({
  before,
  after,
  current,
});
const manifest = (current: string) => ({ before: 'mb', after: 'ma', current });

it('reports a finished write as landed, whatever happened to the files since', () => {
  expect(classifyInterrupted(manifest('ma'), [file('a')])).toBe('landed');
  expect(classifyInterrupted(manifest('ma'), [file('edited later')])).toBe('landed');
  expect(classifyInterrupted(manifest('ma'), [])).toBe('landed');
});

it('treats a later manifest with every file in place as landed', () => {
  expect(classifyInterrupted(manifest('re-pulled'), [file('a'), file(null, 'b', null)])).toBe(
    'landed',
  );
});

it('reports nothing changed when manifest and files are all as before', () => {
  expect(classifyInterrupted(manifest('mb'), [file('b'), file(null, null)])).toBe('nothing');
  expect(classifyInterrupted(manifest('mb'), [])).toBe('nothing');
});

it('reports a partial write, including every file written but no manifest', () => {
  expect(classifyInterrupted(manifest('mb'), [file('a'), file('b')])).toBe('partial');
  expect(classifyInterrupted(manifest('mb'), [file('a'), file('a')])).toBe('partial');
  expect(classifyInterrupted(manifest('mb'), [file(null, 'b', null), file('b')])).toBe('partial');
});

it('leaves it to the user when something else changed a file or the manifest', () => {
  expect(classifyInterrupted(manifest('mb'), [file('a'), file('someone else')])).toBe('foreign');
  expect(classifyInterrupted(manifest('elsewhere'), [file('b')])).toBe('foreign');
  expect(classifyInterrupted(manifest('elsewhere'), [file('a'), file('x')])).toBe('foreign');
});
