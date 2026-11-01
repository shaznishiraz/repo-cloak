import { useEffect, useState } from 'preact/hooks';
import { poll } from '../../api/client.js';
import type { AgentRequest, AgentRequestDetail, AgentRequestState } from '../../api/contracts.js';
import { registerCommands } from '../../shell/commands.js';
import { api } from '../../shell/load.js';
import { overview } from '../../shell/state.js';
import { Badge, Button, Checkbox, EmptyState, Panel, Tabs, toast } from '../../shell/ui/index.js';
import type { BadgeTone } from '../../shell/ui/index.js';
import { CheckList, LoadError, ago, errorText, useLoad } from '../repos/shared.js';

type Filter = 'waiting' | 'decided' | 'all';
const tones: Record<AgentRequestState, BadgeTone> = {
  waiting: 'accent',
  blocked: 'blocked',
  approved: 'ok',
  pulled: 'ok',
  denied: 'neutral',
  failed: 'blocked',
};
const open = new Set<AgentRequestState>(['waiting', 'blocked', 'failed']);

export function filterRequests(requests: AgentRequest[], filter: Filter) {
  if (filter === 'all') return requests;
  return requests.filter((request) => open.has(request.state) === (filter === 'waiting'));
}

function RequestDetail({
  detail,
  busy,
  onApprove,
  onDeny,
}: {
  detail: AgentRequestDetail;
  busy: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const decided = !open.has(detail.state);
  const blocked = detail.checks.some((check) => check.state === 'blocked');
  return (
    <>
      <div>
        <div class="adm-meta">
          {detail.workspaceName} · asked by an agent · {ago(detail.createdAt)} ago ·{' '}
          <Badge tone={tones[detail.state]}>{detail.state}</Badge>
        </div>
        <h2 class="adm-h1">{detail.path}</h2>
        {/* Written by the agent: shown as text and never acted on. */}
        <div class="adm-reason">“{detail.reason}”</div>
      </div>
      {!decided && (
        <Panel title="Policy check">
          <CheckList checks={detail.checks} />
        </Panel>
      )}
      {!decided && detail.preview !== null && (
        <Panel
          title={
            <>
              What the agent would receive <span class="adm-meta">cloaked preview</span>
            </>
          }
        >
          <pre class="adm-code">{detail.preview}</pre>
        </Panel>
      )}
      {!decided && (
        <>
          <div class="adm-flex">
            <Button variant="primary" disabled={busy || blocked} onClick={onApprove}>
              Approve &amp; pull
            </Button>
            <Button disabled title="Not available yet">
              Send signatures only
            </Button>
            <Button disabled={busy} onClick={onDeny}>
              Deny
            </Button>
            <Checkbox label="Auto-approve matching files in this cloak" disabled />
          </div>
          <p class="adm-note">
            Signatures-only and auto-approve need engine support and are not available yet.
          </p>
        </>
      )}
    </>
  );
}

export function RequestsScreen() {
  const [requests, setRequests] = useState<AgentRequest[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('waiting');
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(
    () =>
      poll(() => api().call('GET /api/v2/requests'), {
        onData(value) {
          setRequests(value.requests);
          setListError(null);
        },
        onError: (error) => setListError(errorText(error)),
      }),
    [generation],
  );
  const shown = filterRequests(requests, filter);
  const active = shown.find((request) => request.id === selected) ?? shown[0];
  const activeKey = active ? `${active.workspaceId}\0${active.id}` : undefined;
  const detail = useLoad(
    () =>
      active
        ? api().call('GET /api/v2/requests/:workspaceId/:id', {
            params: { workspaceId: active.workspaceId, id: active.id },
          })
        : Promise.resolve(null),
    [activeKey],
  );
  useEffect(
    () =>
      registerCommands(() =>
        requests
          .filter((request) => request.state === 'waiting')
          .map((request) => ({
            id: `request-${request.id}`,
            group: 'Agent requests',
            title: `Review ${request.path}`,
            subtitle: request.workspaceName,
            icon: '?',
            run: () => {
              setFilter('waiting');
              setSelected(request.id);
            },
          })),
      ),
    [requests],
  );
  async function decide(decision: 'approve' | 'deny') {
    const current = detail.data;
    if (!current) return;
    setBusy(true);
    try {
      const next = await api().call('POST /api/v2/requests/:workspaceId/:id', {
        params: { workspaceId: current.workspaceId, id: current.id },
        body: decision === 'deny' ? { decision } : { decision, mode: 'full' },
      });
      detail.set(next);
      toast(
        decision === 'deny' ? `Denied ${next.path}` : `Pulled ${next.path} into the cloak`,
        'ok',
      );
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      setBusy(false);
      setGeneration((value) => value + 1);
    }
  }
  const waiting = requests.filter((request) => open.has(request.state)).length;
  const unseen = (overview.value?.pendingAgentRequests ?? 0) - waiting;
  return (
    <main class="screen" aria-label="Agent requests" data-placeholder="50-admin">
      <header class="adm-head">
        <h1 class="adm-title">Agent requests</h1>
        <span class="adm-sub">
          files an AI asked for from inside a cloak · nothing leaves source without you
        </span>
        <div class="adm-head-end">
          <Tabs
            segmented
            label="Filter"
            value={filter}
            onChange={setFilter}
            tabs={[
              { id: 'waiting', label: `Waiting ${waiting}` },
              { id: 'decided', label: 'Decided' },
              { id: 'all', label: 'All' },
            ]}
          />
        </div>
      </header>
      <LoadError message={listError} />
      {unseen > 0 && (
        <p class="adm-note adm-pad">
          {unseen} more waiting in cloaks that cannot be read right now.
        </p>
      )}
      <div class="adm-split">
        <section class="adm-list" aria-label="Requests">
          {shown.length === 0 ? (
            <EmptyState title={filter === 'waiting' ? 'Nothing waiting' : 'No requests here'}>
              Requests appear when an agent asks for a file from inside a cloak.
            </EmptyState>
          ) : (
            <ul class="rows">
              {shown.map((request) => (
                <li key={`${request.workspaceId}:${request.id}`} class="row-item">
                  <button
                    type="button"
                    class={`row${request.id === active?.id ? ' row-selected' : ''}`}
                    aria-current={request.id === active?.id ? 'true' : undefined}
                    onClick={() => setSelected(request.id)}
                  >
                    <span class="adm-request">
                      <span class="adm-request-top">
                        <Badge tone={tones[request.state]}>{request.state}</Badge>
                        <span class="adm-meta-mono adm-mono-cut">{request.workspaceName}</span>
                        <span class="adm-meta adm-push-end">{ago(request.createdAt)}</span>
                      </span>
                      <span class="adm-mono-cut">{request.path}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section class="adm-body" aria-label="Request detail">
          <LoadError message={detail.error} />
          {detail.data && (
            <RequestDetail
              detail={detail.data}
              busy={busy}
              onApprove={() => void decide('approve')}
              onDeny={() => void decide('deny')}
            />
          )}
        </section>
      </div>
    </main>
  );
}
