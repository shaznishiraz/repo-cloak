export type InterruptedState = 'landed' | 'nothing' | 'partial' | 'foreign';
type Hashes = { before: string | null; after: string | null; current: string | null };

/**
 * What an unfinished push left behind, from the hashes its journal recorded. The manifest is
 * written after every file, so a manifest still at `before` means the write never finished.
 */
export function classifyInterrupted(manifest: Hashes, files: Hashes[]): InterruptedState {
  const allAfter = files.every((file) => file.current === file.after);
  if (manifest.current === manifest.after) return 'landed';
  if (manifest.current !== manifest.before) return allAfter ? 'landed' : 'foreign';
  if (files.every((file) => file.current === file.before)) return 'nothing';
  return files.every((file) => file.current === file.before || file.current === file.after)
    ? 'partial'
    : 'foreign';
}
