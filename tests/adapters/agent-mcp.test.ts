import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createMcpClient } from '../../scripts/lib/mcp-client.mjs';
import { createAgentMcp } from '../../src/adapters/agent-mcp.js';

function connect(server: ReturnType<typeof createAgentMcp>) {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const done = server.connect(toServer, toClient);
  return {
    client: createMcpClient(toServer, toClient),
    close: () => {
      toServer.end();
      return done;
    },
  };
}

it('exposes only scoped request tools and never leaks credentials or follows external descriptors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak mcp '));
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
  const { client, close } = connect(server);
  try {
    await mkdir(join(root, '.repo-cloak/agent'), { recursive: true });
    await writeFile(join(root, '.repo-cloak/agent/token'), 'ws_test.' + 'a'.repeat(64));
    const descriptor = join(root, '.repo-cloak/agent/connection.json');
    await writeFile(
      descriptor,
      JSON.stringify({ protocol: 1, workspaceId: 'ws_test', baseUrl: 'http://127.0.0.1:1234' }),
    );
    await client.initialize();
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'cloak_probe_files',
      'cloak_request_files',
      'cloak_request_status',
      'cloak_workspace_info',
    ]);
    const result = await client.callTool('cloak_probe_files', { paths: ['src/Context.ts'] });
    expect(JSON.stringify(result)).toContain('available');
    expect(JSON.stringify(result)).not.toContain('ws_test.' + 'a'.repeat(64));
    expect(calls).toEqual([
      { url: 'http://127.0.0.1:1234/agent/v1/probe', token: 'Bearer ws_test.' + 'a'.repeat(64) },
    ]);
    await writeFile(descriptor, JSON.stringify({ baseUrl: 'https://external.example' }));
    expect((await client.callTool('cloak_workspace_info')).isError).toBe(true);
    expect(calls).toHaveLength(1);
    await writeFile(
      descriptor,
      JSON.stringify({ protocol: 1, workspaceId: 'ws_test', baseUrl: 'http://127.0.0.1:1234' }),
    );
    await writeFile(join(root, '.repo-cloak/agent/token'), 'ws_foreign.' + 'b'.repeat(64));
    expect((await client.callTool('cloak_workspace_info')).isError).toBe(true);
    expect(calls).toHaveLength(1);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps the original tool limits and tells the agent there is no approval tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloak mcp limits '));
  const requests: string[] = [];
  const { client, close } = connect(
    createAgentMcp(root, 'ws_test', async (url) => {
      requests.push(String(url));
      return new Response('{}');
    }),
  );
  try {
    const info = await client.initialize();
    expect(info.serverInfo.name).toBe('repo-cloak');
    expect(info.instructions).toContain('No approval, source search, raw read, pull or push tool');
    const paths = (count: number) => Array.from({ length: count }, (_, index) => `f${index}`);
    const rejected = [
      ['cloak_probe_files', { paths: [] }],
      ['cloak_probe_files', { paths: paths(101) }],
      ['cloak_probe_files', { paths: ['x'.repeat(1025)] }],
      ['cloak_request_files', { paths: paths(21), reason: 'r', clientRequestId: 'c' }],
      ['cloak_request_files', { paths: ['a'], reason: '', clientRequestId: 'c' }],
      ['cloak_request_files', { paths: ['a'], reason: 'x'.repeat(501), clientRequestId: 'c' }],
      ['cloak_request_files', { paths: ['a'], reason: 'r', clientRequestId: 'x'.repeat(101) }],
      ['cloak_request_status', { requestId: 'not-a-uuid' }],
      ['cloak_request_status', {}],
    ] as const;
    for (const [name, args] of rejected)
      expect((await client.callTool(name, args)).isError, JSON.stringify([name])).toBe(true);
    expect(requests).toEqual([]);
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === 'cloak_probe_files')).toMatchObject({
      inputSchema: {
        type: 'object',
        required: ['paths'],
        properties: { paths: { type: 'array', maxItems: 100 } },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
    expect(tools.find((tool) => tool.name === 'cloak_request_files')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
