import { useEffect, useRef, useState } from 'preact/hooks';
import { Button, Dialog, Mono } from '../../shell/ui/index.js';
import { api } from '../../shell/load.js';
import {
  applyChanges,
  diffProfiles,
  duplicateLines,
  lineChanges,
  moveLines,
  outlineOf,
} from './document.js';
import type { EditResult, PasteChange } from './document.js';
import { isError } from './problems.js';
import type { LocatedProblem } from './problems.js';
import { asProfileDoc } from './rules.js';
import type { ProfileDoc } from './rules.js';
import type { Problem } from './state.js';

export function JsonEditor({
  text,
  savedText,
  problems,
  onText,
}: {
  text: string;
  savedText: string;
  problems: LocatedProblem[];
  onText: (text: string) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<EditResult | null>(null);
  useEffect(() => {
    const next = selection.current;
    if (next && area.current) area.current.setSelectionRange(next.start, next.end);
    selection.current = null;
  });
  const lines = text.split('\n');
  const { added, removed } = lineChanges(savedText, text);
  const errors = new Set(problems.filter(isError).map((problem) => problem.line));
  const warnings = new Set(
    problems.filter((problem) => !isError(problem)).map((problem) => problem.line),
  );
  const mark = (line: number) =>
    errors.has(line)
      ? 'pf-line-err'
      : warnings.has(line)
        ? 'pf-line-warn'
        : added.has(line)
          ? 'pf-line-add'
          : '';
  function onKeyDown(event: KeyboardEvent) {
    const target = event.currentTarget as HTMLTextAreaElement;
    const { selectionStart: start, selectionEnd: end } = target;
    let result: EditResult | undefined;
    if (event.altKey && event.key === 'ArrowUp') result = moveLines(text, start, end, -1);
    else if (event.altKey && event.key === 'ArrowDown') result = moveLines(text, start, end, 1);
    else if ((event.metaKey || event.ctrlKey) && event.key === 'd')
      result = duplicateLines(text, start, end);
    if (!result) return;
    event.preventDefault();
    selection.current = result;
    onText(result.text);
  }
  return (
    <>
      <div class="pf-json-bar">
        <span>
          schema <Mono muted>profile@1</Mono>
        </span>
        <span>
          unsaved changes{' '}
          <span class="pf-changes">
            +{savedText ? added.size : lines.length} −{savedText ? removed : 0}
          </span>
        </span>
        <span>bulk edit: select rows, ⌥↑↓ to move, ⌘D duplicate</span>
      </div>
      <div class="pf-json-scroll">
        <div class="pf-json">
          <div class="pf-gutter" aria-hidden="true">
            {lines.map((_line, index) => (
              <div key={index} class={mark(index + 1)}>
                {index + 1}
              </div>
            ))}
          </div>
          <div class="pf-code">
            <div class="pf-back" aria-hidden="true">
              {lines.map((_line, index) => (
                <div key={index} class={mark(index + 1)} />
              ))}
            </div>
            <textarea
              ref={area}
              class="pf-area"
              aria-label="Profile JSON"
              spellcheck={false}
              wrap="off"
              rows={lines.length}
              cols={Math.max(40, ...lines.map((line) => line.length + 2))}
              value={text}
              onInput={(event) => onText(event.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
          </div>
        </div>
      </div>
    </>
  );
}

export function ProblemsPanel({ problems }: { problems: LocatedProblem[] }) {
  return (
    <section class="pf-side" aria-label="Problems">
      <h2 class="pf-side-title">Problems</h2>
      {!problems.length && <p class="pf-ok">✓ No problems</p>}
      {problems.map((problem) => (
        <div key={`${problem.path}:${problem.message}`} class="pf-problem">
          <span class={`mono ${isError(problem) ? 'pf-bad' : 'pf-warn'}`} aria-hidden="true">
            {isError(problem) ? '×' : '!'}
          </span>
          <span>
            {problem.line !== undefined && `Line ${problem.line}: `}
            {problem.message}
          </span>
        </div>
      ))}
    </section>
  );
}

export function OutlinePanel({
  doc,
  inherited,
}: {
  doc: ProfileDoc | undefined;
  inherited: number;
}) {
  if (!doc) return null;
  const outline = outlineOf(doc, inherited);
  return (
    <section class="pf-side" aria-label="Outline">
      <h2 class="pf-side-title">Outline</h2>
      <div class="pf-outline mono">
        <div>name · description</div>
        <div>rules {outline.rules}</div>
        {outline.byKind.length > 0 && (
          <div class="pf-indent">
            {outline.byKind.map((item) => `${item.label} ${item.count}`).join(' · ')}
          </div>
        )}
        <div>
          exclude {outline.exclude}
          {outline.inherited ? ` + ${outline.inherited} inherited` : ''}
        </div>
        <div>include {outline.include}</div>
      </div>
    </section>
  );
}

/** Nothing reaches the draft until the user accepts it, and nothing is saved even then. */
export function PasteDialog({
  open,
  current,
  onClose,
  onApply,
}: {
  open: boolean;
  current: ProfileDoc | undefined;
  onClose: () => void;
  onApply: (doc: ProfileDoc) => void;
}) {
  const [pasted, setPasted] = useState('');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [refused, setRefused] = useState(false);
  const [incoming, setIncoming] = useState<ProfileDoc | null>(null);
  const [changes, setChanges] = useState<PasteChange[] | null>(null);
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set());
  function reset() {
    setPasted('');
    setProblems([]);
    setRefused(false);
    setIncoming(null);
    setChanges(null);
    setAccepted(new Set());
  }
  function close() {
    reset();
    onClose();
  }
  async function check() {
    setProblems([]);
    setRefused(false);
    setChanges(null);
    let document: unknown;
    try {
      document = JSON.parse(pasted.replace(/^\uFEFF/, ''));
    } catch {
      setProblems([{ path: '', message: 'This is not valid JSON.' }]);
      return;
    }
    try {
      const result = await api().call('POST /api/v2/profiles/validate', { body: { document } });
      const found = result.problems as Problem[];
      if (found.some((problem) => problem.severity === 'secret')) {
        // Drop the pasted text at once: it should not stay on screen or in memory.
        setPasted('');
        setRefused(true);
        setProblems(found.filter((problem) => problem.severity === 'secret'));
        return;
      }
      const errors = found.filter(isError);
      const doc = asProfileDoc(document);
      if (errors.length || !doc || !current) {
        setProblems(errors.length ? errors : [{ path: '', message: 'Not a profile document.' }]);
        return;
      }
      setIncoming(doc);
      setChanges(diffProfiles(current, doc));
      setAccepted(new Set());
    } catch (error) {
      setProblems([{ path: '', message: error instanceof Error ? error.message : 'Check failed' }]);
    }
  }
  function toggle(id: string, on: boolean) {
    const next = new Set(accepted);
    if (on) next.add(id);
    else next.delete(id);
    setAccepted(next);
  }
  return (
    <Dialog
      title="Paste from LLM"
      open={open}
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          {changes ? (
            <Button
              variant="primary"
              disabled={!accepted.size || !incoming || !current}
              onClick={() => {
                if (incoming && current) onApply(applyChanges(current, incoming, accepted));
                close();
              }}
            >
              Apply {accepted.size} accepted
            </Button>
          ) : (
            <Button variant="primary" disabled={!pasted.trim()} onClick={() => void check()}>
              Check and diff
            </Button>
          )}
        </>
      }
    >
      <p class="pf-note">
        Validated, diffed against this profile and never saved until you accept each change. Secret
        values are refused.
      </p>
      {!changes && (
        <textarea
          class="input pf-textarea pf-mono"
          aria-label="Pasted profile JSON"
          rows={10}
          spellcheck={false}
          value={pasted}
          onInput={(event) => setPasted(event.currentTarget.value)}
        />
      )}
      {refused && (
        <p class="pf-row-error" role="alert">
          Refused: this paste contains secret values. It was discarded and nothing was kept.
        </p>
      )}
      {problems.map((problem) => (
        <p key={`${problem.path}:${problem.message}`} class="pf-row-error">
          {problem.path && <span class="mono">{problem.path}: </span>}
          {problem.message}
        </p>
      ))}
      {changes && !changes.length && <p class="pf-note">No differences from this profile.</p>}
      {changes && changes.length > 0 && (
        <ul class="pf-changes-list" aria-label="Changes">
          {changes.map((change) => (
            <li key={change.id}>
              <label class="check">
                <input
                  type="checkbox"
                  checked={accepted.has(change.id)}
                  onChange={(event) => toggle(change.id, event.currentTarget.checked)}
                />
                <span>
                  <strong>{change.kind}</strong> {change.label}
                  {change.before && <span class="pf-before mono">{change.before}</span>}
                  {change.after && <span class="pf-after mono">{change.after}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
