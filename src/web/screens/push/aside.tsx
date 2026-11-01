import type { GuardCheck, PushApply, PushBackup, PushReview } from '../../api/contracts.js';
import { Button, Checkbox, Field, Radio } from '../../shell/ui/index.js';
import { checkIcon, listedChecks } from './model.js';

export type PushForm = {
  mode: PushApply['mode'];
  commitMessage: string;
  repull: boolean;
  includeGroupMembers: boolean;
};

function Check({ check }: { check: GuardCheck }) {
  return (
    <div class="push-check" data-check={check.id} data-state={check.state}>
      <span class={`push-check-icon push-check-${check.state}`} aria-hidden="true">
        {checkIcon[check.state]}
      </span>
      <span>
        <span class="push-check-title">
          <span class="sr-only">{check.state}: </span>
          {check.title}
        </span>
        {check.detail && <span class="push-check-detail">{check.detail}</span>}
      </span>
    </div>
  );
}

export function PushAside({
  review,
  form,
  onForm,
  fileCount,
  groupMembers,
  pushLabel,
  blockedBecause,
  busy,
  onPush,
  backup,
  onUndo,
  message,
}: {
  review: PushReview | undefined;
  form: PushForm;
  onForm: (form: Partial<PushForm>) => void;
  fileCount: number;
  groupMembers: { names: string[]; group: string } | undefined;
  pushLabel: string;
  blockedBecause: string | undefined;
  busy: boolean;
  onPush: () => void;
  backup: PushBackup | undefined;
  onUndo: () => void;
  message: string | undefined;
}) {
  const files = fileCount === 1 ? 'this file' : `these ${fileCount} files`;
  const radio = (value: PushApply['mode'], label: string) => (
    <Radio
      name="push-mode"
      label={label}
      checked={form.mode === value}
      onChange={() => onForm({ mode: value })}
    />
  );
  return (
    <aside class="push-aside" aria-label="Checks and options">
      <div class="push-block">
        <div class="push-label">Before it lands</div>
        {review ? (
          listedChecks(review).map((check) => <Check key={check.id} check={check} />)
        ) : (
          <span class="push-meta">Checking…</span>
        )}
      </div>
      {!!review?.derivedNames.length && (
        <div class="push-block">
          <div class="push-block-title">
            New name{review.derivedNames.length === 1 ? '' : 's'} Claude introduced
          </div>
          {review.derivedNames.map((name) => (
            <div class="push-names" key={name.cloaked}>
              <span class="push-name-cloak" title={name.cloaked}>
                {name.cloaked}
              </span>
              <span class="push-sep">→</span>
              <span title={name.restored}>{name.restored}</span>
            </div>
          ))}
          <div class="push-meta">
            Derived from your rules. <a href="#/profiles">Edit rules</a>
          </div>
        </div>
      )}
      <div class="push-block">
        <div class="push-block-title">In the target</div>
        {radio('write', 'Write files only')}
        {radio('stage', 'Write + stage')}
        {radio('commit', 'Write + commit')}
        <Field
          label="Commit message (restored, never cloaked)"
          value={form.commitMessage}
          disabled={form.mode !== 'commit'}
          error={message}
          onInput={(event) => onForm({ commitMessage: event.currentTarget.value })}
        />
      </div>
      <div class="push-block">
        <Checkbox
          label={`Re-pull ${files} after push`}
          checked={form.repull}
          onChange={(event) => onForm({ repull: event.currentTarget.checked })}
        />
        {groupMembers && (
          <Checkbox
            label={`Also push ${groupMembers.names.join(', ')} (group ${groupMembers.group})`}
            checked={form.includeGroupMembers}
            onChange={(event) => onForm({ includeGroupMembers: event.currentTarget.checked })}
          />
        )}
      </div>
      <div class="push-foot">
        <Button
          variant="primary"
          class="push-go"
          disabled={busy || blockedBecause !== undefined}
          onClick={onPush}
        >
          {busy ? 'Pushing…' : pushLabel}
        </Button>
        {blockedBecause && <span class="push-why">{blockedBecause}</span>}
        <span class="push-backup">
          Backup of overwritten source files kept for 7 days
          {backup && (
            <>
              {' · '}
              <button type="button" class="push-link" disabled={busy} onClick={onUndo}>
                undo
              </button>
            </>
          )}
        </span>
      </div>
    </aside>
  );
}
