import { useEffect, useRef, useState } from 'preact/hooks';
import type { DiffLine, PushFile } from '../../api/contracts.js';
import { IconButton, Tabs } from '../../shell/ui/index.js';
import { baseName, splitHunks } from './model.js';

export type DiffMode = 'both' | 'restored';
const marks: Record<DiffLine['kind'], string> = { context: ' ', add: '+', remove: '-' };

function Cell({ line, text }: { line: DiffLine; text: string }) {
  return (
    <div class={`push-cell push-${line.kind}`}>
      <span class="push-ln">{line.line}</span>
      {`${marks[line.kind]} ${text}`}
    </div>
  );
}

export function DiffPane({
  file,
  lines,
  error,
  mode,
  onMode,
}: {
  file: PushFile | undefined;
  lines: DiffLine[] | undefined;
  error: string | undefined;
  mode: DiffMode;
  onMode: (mode: DiffMode) => void;
}) {
  const hunks = splitHunks(lines ?? []);
  const [at, setAt] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => setAt(0), [file?.path]);
  function go(next: number) {
    setAt(next);
    scroller.current
      ?.querySelector(`[data-hunk="${next}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }
  return (
    <>
      <div class="push-diff-head">
        <span class="mono">{file ? baseName(file.restoredPath) : 'No file selected'}</span>
        {hunks.length > 0 && (
          <span class="push-meta push-hunks">
            hunk {at + 1} of {hunks.length}
            <IconButton
              label="Previous hunk"
              size="small"
              disabled={at === 0}
              onClick={() => go(at - 1)}
            >
              ↑
            </IconButton>
            <IconButton
              label="Next hunk"
              size="small"
              disabled={at >= hunks.length - 1}
              onClick={() => go(at + 1)}
            >
              ↓
            </IconButton>
          </span>
        )}
        <div class="push-diff-mode">
          <Tabs
            segmented
            label="Diff view"
            value={mode}
            onChange={onMode}
            tabs={[
              { id: 'both', label: 'Cloak ↔ restored' },
              { id: 'restored', label: 'Restored diff only' },
            ]}
          />
        </div>
      </div>
      <div class="push-scroller" ref={scroller} tabIndex={0} role="region" aria-label="Diff">
        {mode === 'both' ? (
          <div class="push-columns">
            <div class="push-column-title push-column-cloak">What Claude edited · cloak</div>
            <div class="push-column-title">What lands in source · restored</div>
          </div>
        ) : (
          <div class="push-column-title push-column-single">What lands in source · restored</div>
        )}
        {error ? (
          <p class="push-diff-note" role="alert">
            {error}
          </p>
        ) : !file ? (
          <p class="push-diff-note">Select a file to see what changes.</p>
        ) : lines === undefined ? (
          <p class="push-diff-note">Loading diff…</p>
        ) : !lines.length ? (
          <p class="push-diff-note">
            No text diff to show: the file is binary or too large to compare here.
          </p>
        ) : (
          <div class={mode === 'both' ? 'push-lines' : 'push-lines push-lines-single'}>
            {hunks.map((hunk, index) => (
              <div key={index} data-hunk={index} class={index ? 'push-hunk-next' : undefined}>
                {hunk.map((line, row) => (
                  <div key={row} class={mode === 'both' ? 'push-row' : undefined}>
                    {mode === 'both' && <Cell line={line} text={line.cloaked} />}
                    <Cell line={line} text={line.restored} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
