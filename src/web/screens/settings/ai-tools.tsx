import { useState } from 'preact/hooks';
import { api } from '../../shell/load.js';
import { overview } from '../../shell/state.js';
import { Button, Checkbox, Mono, toast } from '../../shell/ui/index.js';
import { LoadError, copyText, errorText, useLoad } from '../repos/shared.js';

/** Agent access and MCP client setup for one cloak at a time. */
export function AiTools() {
  const workspaces = overview.value?.workspaces ?? [];
  const [chosen, setChosen] = useState<string>();
  const workspace = workspaces.find((item) => item.id === chosen) ?? workspaces[0];
  const params = workspace ? { repoId: workspace.repoId, workspaceId: workspace.id } : undefined;
  const key = workspace?.id;
  const access = useLoad(
    () =>
      params
        ? api().call('GET /api/v2/agents/:repoId/:workspaceId', { params })
        : Promise.resolve(null),
    [key],
  );
  const setup = useLoad(
    () =>
      params
        ? api().call('GET /api/v2/agents/:repoId/:workspaceId/mcp', { params })
        : Promise.resolve(null),
    [key],
  );
  async function configure(body: { enabled: boolean; rotate?: boolean }) {
    if (!params) return;
    try {
      access.set(await api().call('PUT /api/v2/agents/:repoId/:workspaceId', { params, body }));
      toast(
        body.rotate
          ? 'Connection rotated. Reconnect the agent.'
          : `Agent requests ${body.enabled ? 'on' : 'off'}`,
        'ok',
      );
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }
  async function install(provider: 'claude' | 'codex') {
    if (!params) return;
    try {
      const result = (await api().call('POST /api/v2/agents/:repoId/:workspaceId/mcp/:provider', {
        params: { ...params, provider },
        body: { confirm: true },
      })) as { message?: string };
      toast(result.message ?? 'Connection added', 'ok');
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }
  if (!workspace) return <p class="adm-note adm-pad">Create a cloak to connect an agent to it.</p>;
  return (
    <div class="adm-form">
      <label class="adm-form-label" for="adm-agent-workspace">
        Cloak
      </label>
      <select
        id="adm-agent-workspace"
        class="adm-select"
        value={workspace.id}
        onChange={(event) => setChosen(event.currentTarget.value)}
      >
        {workspaces.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <span>Agent file requests</span>
      <span class="adm-flex">
        {access.data && (
          <Checkbox
            label="Let agents in this cloak ask for files"
            checked={access.data.enabled}
            onChange={(event) => void configure({ enabled: event.currentTarget.checked })}
          />
        )}
        <Button
          size="small"
          disabled={!access.data?.enabled}
          onClick={() => void configure({ enabled: true, rotate: true })}
        >
          Rotate connection
        </Button>
      </span>
      <span>MCP server</span>
      <span class="adm-flex">
        <Mono>{setup.data?.name ?? '…'}</Mono>
        <Button
          size="small"
          disabled={!setup.data}
          onClick={() => void copyText(setup.data?.claude ?? '', 'the Claude Code config')}
        >
          Copy config for Claude Code
        </Button>
        <Button
          size="small"
          disabled={!setup.data}
          onClick={() => void copyText(setup.data?.codex ?? '', 'the Codex config')}
        >
          Copy config for Codex
        </Button>
        <Button size="small" onClick={() => void install('claude')}>
          Add to Claude Code
        </Button>
        <Button size="small" onClick={() => void install('codex')}>
          Add to Codex
        </Button>
      </span>
      <span>Generate AGENTS.md</span>
      <span class="adm-meta">
        On create · tells the agent it is in a cloak and how to ask for files
      </span>
      <LoadError message={access.error ?? setup.error} />
    </div>
  );
}
