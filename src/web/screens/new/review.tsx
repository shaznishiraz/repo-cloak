import type { NewCloakReview } from '../../api/contracts.js';
import { Button, Kbd } from '../../shell/ui/index.js';
import { compactCount } from './model.js';

const listLimit = 40;

function Stat({ value, label, alert }: { value: string; label: string; alert?: boolean }) {
  return (
    <div>
      <div class={`stat-value${alert ? ' stat-alert' : ''}`}>{value}</div>
      <div class="stat-label">{label}</div>
    </div>
  );
}

export function ReviewAside({
  review,
  error,
  loading,
  adding,
  group,
  ignored,
  onIgnore,
  createLabel,
  blocker,
  busy,
  onCreate,
}: {
  review: NewCloakReview | null;
  error: string | null;
  loading: boolean;
  adding: boolean;
  group: string | null;
  ignored: boolean;
  onIgnore: (value: boolean) => void;
  createLabel: string;
  blocker: string | null;
  busy: boolean;
  onCreate: () => void;
}) {
  const held = review?.heldBack ?? [];
  const leftovers = review?.leftovers ?? [];
  // The first entry is the repository folder; the name is suggested from it.
  const paths = review?.pathPreview.slice(1, 4) ?? [];
  const cli = review ? `${review.cli}${group ? ` --group ${group}` : ''}` : '';
  return (
    <aside class="review" aria-label="Review" aria-busy={loading}>
      <div class="review-section">
        <div class="label">Review{loading ? ' · updating…' : ''}</div>
        <div class="review-stats">
          <Stat value={String(review?.files ?? 0)} label="files out" />
          <Stat value={compactCount(review?.lines ?? 0)} label="lines" />
          <Stat value={String(held.length)} label="held back" alert={held.length > 0} />
        </div>
      </div>

      {error && (
        <div class="review-section review-error" role="alert">
          <span class="mono">!</span> {error}
        </div>
      )}

      {adding && (
        <div class="review-section review-note">
          Adding keeps this cloak's own profiles. The replacements are applied when you add.
        </div>
      )}

      <div class="review-section">
        <h3 class="review-title">Held back by exclusions</h3>
        {held.length === 0 && <p class="muted">Nothing held back.</p>}
        {held.slice(0, listLimit).map((item) => (
          <div class="held" key={item.path}>
            <span class="held-path" title={item.path}>
              {item.path}
            </span>
            <span class="held-rule">{item.rule}</span>
          </div>
        ))}
        {held.length > listLimit && <p class="muted">and {held.length - listLimit} more</p>}
      </div>

      {!adding && (
        <div class="review-section">
          <h3 class="review-title review-title-split">
            <span>Replacements that will hit</span>
            <span class="muted">hits</span>
          </h3>
          {!review?.replacements.length && <p class="muted">No replacements yet.</p>}
          {review?.replacements.slice(0, listLimit).map((item) => (
            <div class="replacement" key={`${item.find}\0${item.replace}`}>
              <span class="replacement-from" title={item.find}>
                {item.find}
              </span>
              <span class="replacement-arrow" aria-hidden="true">
                →
              </span>
              <span class="replacement-to" title={item.replace}>
                {item.replace}
              </span>
              <span class="replacement-hits">{item.hits}</span>
            </div>
          ))}
        </div>
      )}

      {paths.length > 0 && !adding && (
        <div class="review-section">
          <h3 class="review-title">Path preview</h3>
          {paths.map((path) => (
            <div class="path-preview" key={path.source}>
              <div>{path.source}</div>
              <div class="path-cloaked">{path.cloaked}</div>
            </div>
          ))}
        </div>
      )}

      {leftovers.length > 0 && !adding && (
        <div class="review-section review-leftover" role="status">
          <span class="leftover-mark" aria-hidden="true">
            !
          </span>
          <div>
            <p class="leftover-line">
              {leftovers.length} {leftovers.length === 1 ? 'leftover' : 'leftovers'} with no rule:
            </p>
            {leftovers.slice(0, 5).map((item) => (
              <p class="leftover-line" key={`${item.path}\0${item.name}`}>
                <span class="mono leftover-name">{item.name}</span> in {item.path}
              </p>
            ))}
            {leftovers.length > 5 && <p class="muted">and {leftovers.length - 5} more</p>}
            <p class="leftover-actions">
              <a href="#/profiles">Add rule</a>
              {' · '}
              <button type="button" class="link-button" onClick={() => onIgnore(!ignored)}>
                {ignored ? 'Stop ignoring' : 'Ignore'}
              </button>
              {ignored && <span class="muted"> Ignored for this cloak.</span>}
            </p>
          </div>
        </div>
      )}

      {cli && !adding && (
        <div class="review-section">
          <div class="muted">CLI equivalent · planned, this version has no pull command yet</div>
          <div class="cli-line">{cli}</div>
        </div>
      )}

      <div class="review-foot">
        <Button
          variant="primary"
          class="review-create"
          disabled={!!blocker || busy}
          onClick={onCreate}
        >
          {busy ? 'Working…' : createLabel}
        </Button>
        <Kbd>⌘↵</Kbd>
      </div>
      {blocker && <p class="review-blocker muted">{blocker}</p>}
    </aside>
  );
}
