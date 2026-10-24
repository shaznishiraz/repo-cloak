/** Estimate retained plan data without expanding file buffers into JSON arrays. */
export function estimateRetainedBytes(value: unknown): number {
  const seen = new WeakSet<object>();
  function size(item: unknown): number {
    if (typeof item === 'string') return 24 + item.length * 2;
    if (item === null || typeof item !== 'object') return 8;
    if (seen.has(item)) return 0;
    seen.add(item);
    if (ArrayBuffer.isView(item)) return 64 + size(item.buffer);
    if (item instanceof ArrayBuffer) return item.byteLength;
    let bytes = 64;
    for (const [key, child] of Object.entries(item)) bytes += 16 + key.length * 2 + size(child);
    return bytes;
  }
  return size(value);
}
