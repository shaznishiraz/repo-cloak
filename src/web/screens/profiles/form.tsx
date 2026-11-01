import { useState } from 'preact/hooks';
import type { LockedExclusion, ProfileRuleKind } from '../../api/contracts.js';
import { Badge, Button, IconButton, Mono, Panel } from '../../shell/ui/index.js';
import type { BadgeTone } from '../../shell/ui/index.js';
import { isError } from './problems.js';
import type { LocatedProblem } from './problems.js';
import {
  addRule,
  kindLabels,
  removeRule,
  rowOf,
  ruleKinds,
  secretDetectorOptions,
  setList,
  updateRow,
} from './rules.js';
import type { ProfileDoc, RuleRow } from './rules.js';

const tones: Record<ProfileRuleKind, BadgeTone> = {
  brand: 'accent',
  keyword: 'pull',
  term: 'ok',
  regex: 'push',
  secret: 'blocked',
};

function CaseCell({
  row,
  number,
  onPatch,
}: {
  row: RuleRow;
  number: number;
  onPatch: (patch: Partial<RuleRow>) => void;
}) {
  if (row.kind === 'secret') return <span class="pf-case">sealed</span>;
  if (row.kind === 'regex')
    return (
      <input
        class="input pf-cell"
        aria-label={`Flags for rule ${number}`}
        title="reversible · flags i, m, s, u"
        placeholder="flags"
        value={row.flags}
        onInput={(event) => onPatch({ flags: event.currentTarget.value })}
      />
    );
  return (
    <select
      class="input pf-cell"
      aria-label={`Case for rule ${number}`}
      value={row.caseMode}
      onChange={(event) => onPatch({ caseMode: event.currentTarget.value as RuleRow['caseMode'] })}
    >
      <option value="preserve">preserve</option>
      <option value="exact">exact</option>
      {row.caseMode === 'custom' && <option value="custom">custom</option>}
    </select>
  );
}

function RuleLine({
  row,
  number,
  hits,
  problems,
  onPatch,
  onRemove,
}: {
  row: RuleRow;
  number: number;
  hits: number | undefined;
  problems: LocatedProblem[];
  onPatch: (patch: Partial<RuleRow>) => void;
  onRemove: () => void;
}) {
  const invalid = problems.some(isError);
  return (
    <div class="pf-rule" role="row" aria-label={`Rule ${number}`}>
      <span role="cell" class="pf-kind">
        <Badge tone={tones[row.kind]}>{row.kind === 'term' ? 'Term' : kindLabels[row.kind]}</Badge>
      </span>
      <span role="cell" class="pf-find">
        {row.kind === 'secret' ? (
          <select
            class="input pf-cell"
            aria-label={`Detector for rule ${number}`}
            value={row.detector}
            onChange={(event) => onPatch({ detector: event.currentTarget.value })}
          >
            {!secretDetectorOptions.some((option) => option.id === row.detector) && (
              <option value={row.detector}>{row.detector}</option>
            )}
            {secretDetectorOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            class="input pf-cell pf-mono"
            aria-label={`Find for rule ${number}`}
            aria-invalid={invalid}
            placeholder={row.kind === 'regex' ? 'pattern' : 'real name'}
            value={row.find}
            onInput={(event) => onPatch({ find: event.currentTarget.value })}
          />
        )}
      </span>
      <span role="cell" class="pf-replace">
        {row.kind === 'secret' ? (
          <span class="pf-sealed mono">••• sealed placeholder</span>
        ) : (
          <input
            class="input pf-cell pf-mono pf-accent"
            aria-label={`Replace for rule ${number}`}
            aria-invalid={invalid}
            placeholder={row.kind === 'regex' ? 'CLM-$1' : 'public name'}
            value={row.replace}
            onInput={(event) => onPatch({ replace: event.currentTarget.value })}
          />
        )}
      </span>
      <span role="cell" class="pf-casecell">
        <CaseCell row={row} number={number} onPatch={onPatch} />
      </span>
      <span role="cell" class="pf-hits mono" title="Replacements in the scanned repository">
        {hits ?? '—'}
      </span>
      <span role="cell" class="pf-remove">
        <IconButton label={`Remove rule ${number}`} size="small" onClick={onRemove}>
          <span aria-hidden="true">×</span>
        </IconButton>
      </span>
      {problems.map((problem) => (
        <p key={problem.message} class={isError(problem) ? 'pf-row-error' : 'pf-row-warn'}>
          {problem.message}
        </p>
      ))}
    </div>
  );
}

function PatternChips({
  label,
  addLabel,
  locked = [],
  patterns,
  tone,
  onChange,
}: {
  label: string;
  addLabel: string;
  locked?: LockedExclusion[];
  patterns: string[];
  tone: 'blocked' | 'neutral';
  onChange: (patterns: string[]) => void;
}) {
  const [next, setNext] = useState('');
  const seen = new Set(locked.map((entry) => entry.pattern));
  function add() {
    const pattern = next.trim();
    if (!pattern) return;
    if (!seen.has(pattern) && !patterns.includes(pattern)) onChange([...patterns, pattern]);
    setNext('');
  }
  return (
    <div class="pf-chips" role="group" aria-label={label}>
      {locked.map((entry) => (
        <span key={entry.pattern} class="pf-chip pf-chip-locked mono">
          {entry.pattern}
          <span class="pf-chip-tag">{entry.source} · locked</span>
        </span>
      ))}
      {patterns.map((pattern) => (
        <span key={pattern} class={`pf-chip pf-chip-${tone} mono`}>
          {pattern}
          <button
            type="button"
            class="pf-chip-x"
            aria-label={`Remove ${pattern}`}
            onClick={() => onChange(patterns.filter((item) => item !== pattern))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        class="input pf-chip-input pf-mono"
        aria-label={addLabel}
        placeholder="+ pattern"
        value={next}
        onInput={(event) => setNext(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          add();
        }}
        onBlur={add}
      />
    </div>
  );
}

export function ProfileForm({
  doc,
  hits,
  hitsIn,
  locked,
  problems,
  onChange,
}: {
  doc: ProfileDoc;
  hits: Record<string, number>;
  hitsIn: string | undefined;
  locked: LockedExclusion[];
  problems: LocatedProblem[];
  onChange: (doc: ProfileDoc) => void;
}) {
  const ruleProblem = /^rules\.(\d+)/;
  const general = problems.filter((problem) => !ruleProblem.test(problem.path));
  return (
    <div class="pf-panels">
      <Panel
        title={
          <>
            Rules
            <span class="pf-note">
              {' '}
              applied to file contents and paths, longest match first
              {hitsIn ? ` · hits in ${hitsIn}` : ''}
            </span>
          </>
        }
        actions={ruleKinds.map((kind) => (
          <Button
            key={kind}
            size="small"
            class="pf-add"
            onClick={() => onChange(addRule(doc, kind))}
          >
            + {kindLabels[kind]}
          </Button>
        ))}
      >
        <div class="pf-table" role="table" aria-label="Rules">
          <div class="pf-rule pf-rule-head" role="row">
            <span role="columnheader">Type</span>
            <span role="columnheader">Find</span>
            <span role="columnheader">Replace with</span>
            <span role="columnheader">Case</span>
            <span role="columnheader" class="pf-right">
              Hits
            </span>
            <span role="columnheader">
              <span class="pf-sr">Remove</span>
            </span>
          </div>
          {doc.rules.map((rule, index) => {
            const row = rowOf(doc, rule);
            return (
              <RuleLine
                key={rule.id}
                row={row}
                number={index + 1}
                hits={hits[rule.id] ?? (hitsIn ? 0 : undefined)}
                problems={problems.filter(
                  (problem) => ruleProblem.exec(problem.path)?.[1] === String(index),
                )}
                onPatch={(patch) => onChange(updateRow(doc, rule.id, patch))}
                onRemove={() => onChange(removeRule(doc, rule.id))}
              />
            );
          })}
          {!doc.rules.length && <p class="pf-empty-rules">No rules yet. Add one by type above.</p>}
        </div>
        {general.map((problem) => (
          <p key={problem.message} class={isError(problem) ? 'pf-row-error' : 'pf-row-warn'}>
            {problem.message}
          </p>
        ))}
      </Panel>
      <Panel
        title={
          <>
            Never pull <span class="pf-note">glob patterns · inherited ones are locked</span>
          </>
        }
      >
        <PatternChips
          label="Never pull patterns"
          addLabel="Add never pull pattern"
          locked={locked}
          patterns={doc.exclude ?? []}
          tone="blocked"
          onChange={(value) => onChange(setList(doc, 'exclude', value))}
        />
      </Panel>
      <Panel
        title={
          <>
            Bring back <span class="pf-note">files skipped by default · never pull still wins</span>
          </>
        }
      >
        <PatternChips
          label="Bring back patterns"
          addLabel="Add bring back pattern"
          patterns={doc.include ?? []}
          tone="neutral"
          onChange={(value) => onChange(setList(doc, 'include', value))}
        />
      </Panel>
      <p class="pf-note pf-foot">
        <Mono muted>boundary</Mono>, <Mono muted>forms</Mono> and <Mono muted>scope</Mono> are kept
        when you edit here; change them in JSON.
      </p>
    </div>
  );
}
