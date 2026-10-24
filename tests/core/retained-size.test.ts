import { expect, it } from 'vitest';
import { estimateRetainedBytes } from '../../src/core/retained-size.js';

it('counts binary backing storage without calling toJSON or expanding byte entries', () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024);
  Object.defineProperty(bytes, 'toJSON', {
    value: () => {
      throw new Error('must not serialize binary contents');
    },
  });
  const size = estimateRetainedBytes({ bytes });
  expect(size).toBeGreaterThanOrEqual(bytes.byteLength);
  expect(size).toBeLessThan(bytes.byteLength + 1024);
});
it('counts shared backing buffers once while accounting for each view', () => {
  const backing = new ArrayBuffer(1024);
  const one = estimateRetainedBytes({ a: new Uint8Array(backing) });
  const two = estimateRetainedBytes({ a: new Uint8Array(backing), b: new Uint8Array(backing) });
  expect(two).toBeGreaterThan(one);
  expect(two - one).toBeLessThan(1024);
});
it('handles shared metadata, cycles and unicode strings without serialization', () => {
  const shared: { text: string; self?: unknown } = { text: '名前' };
  shared.self = shared;
  expect(estimateRetainedBytes({ a: shared, b: shared })).toBeLessThan(
    estimateRetainedBytes({ a: { text: '名前' }, b: { text: '名前' } }),
  );
  expect(estimateRetainedBytes('名前')).toBeGreaterThan(estimateRetainedBytes('a'));
});
