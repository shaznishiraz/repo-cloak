import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentMcp } from '../../src/adapters/agent-mcp.js';

it('exposes only scoped request tools and never leaks credentials or follows external descriptors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak mcp '));
  const client = new Client({ name: 'test-agent', version: '1' });
  const calls: { url: string; token: string | undefined }[] = [];
  const server = createAgentMcp(root, 'ws_test', async (url, options) => {
    calls.push({
      url: String(url),
      token: (options?.headers as Record<string, string>)?.Authorization,
    });
    return new Response(JSON.stringify({ results: { 'src/Context.ts': 'available' } }), {
      status: 200,
    });
  });
  try {
    await mkdir(join(root, '.repo-cloak/agent'), { recursive: true });
    await writeFile(join(root, '.repo-cloak/agent/token'), 'ws_test.' + 'a'.repeat(64));
    const descriptor = join(root, '.repo-cloak/agent/connection.json');
    await writeFile(
      descriptor,
      JSON.stringify({ protocol: 1, workspaceId: 'ws_test', baseUrl: 'http://127.0.0.1:1234' }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'cloak_probe_files',
      'cloak_request_files',
      'cloak_request_status',
      'cloak_workspace_info',
    ]);
    const result = await client.callTool({
      name: 'cloak_probe_files',
      arguments: { paths: ['src/Context.ts'] },
    });
    expect(JSON.stringify(result)).toContain('available');
    expect(JSON.stringify(result)).not.toContain('ws_test.' + 'a'.repeat(64));
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:1234/agent/v1/probe', token: 'Bearer ws_test.' + 'a'.repeat(64) },
    ]);
    await writeFile(descriptor, JSON.stringify({ baseUrl: 'https://external.example' }));
    expect((await client.callTool({ name: 'cloak_workspace_info', arguments: {} })).isError).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
    await writeFile(
      descriptor,
      JSON.stringify({ protocol: 1, workspaceId: 'ws_test', baseUrl: 'http://127.0.0.1:1234' }),
    );
    await writeFile(join(root, '.repo-cloak/agent/token'), 'ws_foreign.' + 'b'.repeat(64));
    expect((await client.callTool({ name: 'cloak_workspace_info', arguments: {} })).isError).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
