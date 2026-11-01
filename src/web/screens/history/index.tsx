import { useEffect, useState } from 'preact/hooks';
import type { AuditEventView, AuditVerification } from '../../api/contracts.js';
import { registerCommands } from '../../shell/commands.js';
import { api } from '../../shell/load.js';
import { Badge, Button, EmptyState, Field, Panel, toast } from '../../shell/ui/index.js';
import { LoadError, errorText, useLoad } from '../repos/shared.js';
import { exportSignedLog } from './audit-actions.js';

const shortHash = (hash: string) => {
  const bare = hash.replace(/^sha256-/, '');
  return `${bare.slice(0, 4)}…${bare.slice(-3)}`;
};
const visibleFiles = 5;

export function whenLabel(iso: string, now = new Date()) {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = Math.floor(
    (new Date(now.toDateString()).getTime() - new Date(at.toDateString()).getTime()) / 86_400_000,
  );
  if (days <= 0) return `today ${time}`;
  if (days === 1) return 'yesterday';
  return days < 30 ? `${days}d ago` : iso.slice(0, 10);
}
function chainLabel(result: AuditVerification | null) {
  if (!result) return 'checking chain…';
  if (!result.ok)
    return `chain broken at line ${result.firstBroken.line}: ${result.firstBroken.reason}`;
  return `chain verified · ${result.count} events`;
}

function EventDetail({
  event,
  previous,
}: {
  event: AuditEventView;
  previous: AuditEventView | undefined;
}) {
  const [all, setAll] = useState(false);
  const files = all ? event.files : event.files.slice(0, visibleFiles);
  const linked = previous?.hash === event.prevHash;
  return (
    <>
      <div>
        <div class="adm-meta">
          event #{event.seq} · {new Date(event.at).toLocaleString()}
        </div>
        <h2 class="panel-title">
          {event.op}
          {event.workspace ? ` · ${event.workspace.name ?? event.workspace.id}` : ''}
        </h2>
      </div>
      <dl class="adm-facts">
        <dt>Outcome</dt>
        <dd>
          <Badge tone={event.outcome === 'ok' ? 'ok' : 'blocked'}>{event.outcome}</Badge>
        </dd>
        <dt>Who</dt>
        <dd>{event.who}</dd>
        {event.detail && (
          <>
            <dt>Detail</dt>
            <dd>{event.detail}</dd>
          </>
        )}
        <dt>Profiles</dt>
        <dd class="adm-mono">
          {event.profiles.map((profile) => shortHash(profile.hash)).join(', ') || 'none'}
        </dd>
        <dt>Key</dt>
        <dd class="adm-mono">{event.keyId ?? 'none'}</dd>
        <dt>Hash</dt>
        <dd class="adm-mono">
          {shortHash(event.hash)}
          {linked ? ` ✓ links #${previous?.seq}` : ` · follows ${shortHash(event.prevHash)}`}
        </dd>
      </dl>
      {event.files.length > 0 && (
        <Panel title={`Files (${event.files.length})`}>
          {files.map((file) => (
            <div key={file.path} class="adm-file">
              <span class="adm-mono-cut" title={file.path}>
                {file.path}
              </span>
              <span class="adm-meta-mono">{file.hash ? shortHash(file.hash) : '—'}</span>
            </div>
          ))}
          {event.files.length > visibleFiles && !all && (
            <div class="adm-pad">
              <Button size="small" onClick={() => setAll(true)}>
                Show all {event.files.length}
              </Button>
            </div>
          )}
        </Panel>
      )}
      <p class="adm-note">
        Events record who, when, which files and which key, never file contents. Exports leave out
        real source names.
      </p>
    </>
  );
}

export function HistoryScreen() {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [more, setMore] = useState<AuditEventView[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<number>();
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [chain, setChain] = useState<AuditVerification | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const page = useLoad(
    () => api().call('GET /api/v2/audit', { query: query ? { q: query } : {} }),
    [query],
  );
  // A rejected filter keeps the last good rows up, with the reason beside the field.
  useEffect(() => {
    if (!page.data) return;
    setEvents(page.data.events);
    setCursor(page.data.nextCursor);
    setMore([]);
  }, [page.data]);
  async function verify() {
    setChain(null);
    setChainError(null);
    try {
      setChain(await api().call('POST /api/v2/audit/verify'));
    } catch (error) {
      setChainError(errorText(error));
    }
  }
  useEffect(() => {
    void verify();
    return registerCommands(() => [
      {
        id: 'audit-verify',
        group: 'Actions',
        title: 'Verify audit chain',
        icon: '✓',
        run: () => void verify(),
      },
      {
        id: 'audit-export',
        group: 'Actions',
        title: 'Export signed log',
        icon: '↓',
        run: () => void exportSignedLog(),
      },
    ]);
  }, []);
  async function loadMore() {
    if (cursor === null) return;
    try {
      const next = await api().call('GET /api/v2/audit', {
        query: { ...(query ? { q: query } : {}), cursor: String(cursor) },
      });
      setMore([...more, ...next.events]);
      setCursor(next.nextCursor);
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }
  const rows = [...events, ...more];
  const active = rows.find((event) => event.seq === selected) ?? rows[0];
  const previous = active && rows.find((event) => event.seq === active.seq - 1);
  return (
    <main class="screen" aria-label="History" data-placeholder="50-admin">
      <header class="adm-head">
        <h1 class="adm-title">History</h1>
        <Badge tone={chainError || (chain && !chain.ok) ? 'blocked' : chain ? 'ok' : 'neutral'}>
          {chainError ?? `${chain?.ok ? '✓ ' : ''}${chainLabel(chain)}`}
        </Badge>
        <Button size="small" variant="ghost" onClick={() => void verify()}>
          Verify chain
        </Button>
        <div class="adm-head-end">
          <div class="adm-filter">
            <Field
              label={<span class="sr-only">Filter history</span>}
              placeholder="Filter: op:push ws:acme since:7d"
              value={text}
              error={page.error ?? undefined}
              onInput={(event) => setText(event.currentTarget.value)}
            />
          </div>
          <Button size="small" onClick={() => void exportSignedLog()}>
            Export signed log
          </Button>
        </div>
      </header>
      <div class="adm-split">
        <section class="adm-body adm-flush" aria-label="Events">
          {page.data && rows.length === 0 ? (
            <EmptyState title={query ? 'No events match' : 'No events yet'}>
              {query ? 'Try a wider filter.' : 'Creating, pulling and pushing are recorded here.'}
            </EmptyState>
          ) : (
            <div class="adm-scroll">
              <div class="adm-labels adm-event-grid">
                <span>When</span>
                <span>Op</span>
                <span>Workspace</span>
                <span>Detail</span>
                <span>Files</span>
                <span>Who</span>
              </div>
              {rows.map((event) => (
                <button
                  key={event.seq}
                  type="button"
                  class={`adm-event adm-event-grid${event.seq === active?.seq ? ' adm-selected' : ''}`}
                  aria-current={event.seq === active?.seq ? 'true' : undefined}
                  onClick={() => setSelected(event.seq)}
                >
                  <span class="adm-meta-mono">{whenLabel(event.at)}</span>
                  <span class={`adm-mono${event.outcome === 'failed' ? ' adm-op-failed' : ''}`}>
                    {event.op}
                    {event.outcome === 'failed' && ' ✕'}
                  </span>
                  <span class="adm-mono-cut">
                    {event.workspace?.name ?? event.workspace?.id ?? '—'}
                  </span>
                  <span class="adm-mono-cut adm-meta">{event.detail ?? '—'}</span>
                  <span class="adm-meta-mono">{event.files.length || '—'}</span>
                  <span class="adm-mono-cut adm-meta">{event.who}</span>
                </button>
              ))}
            </div>
          )}
          {cursor !== null && (
            <div class="adm-pad">
              <Button size="small" onClick={() => void loadMore()}>
                Load older events
              </Button>
            </div>
          )}
        </section>
        {active && (
          <aside class="adm-aside" aria-label="Event detail">
            <EventDetail key={active.seq} event={active} previous={previous} />
          </aside>
        )}
      </div>
      {!page.data && <LoadError message={page.error} />}
    </main>
  );
}
