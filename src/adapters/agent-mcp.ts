import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { version } from '../package.js';
import { checkDestinationPath } from './files.js';
import { createMcpServer } from './mcp-stdio.js';
import type { McpTool } from './mcp-stdio.js';

export function createAgentMcp(
  workspace: string,
  workspaceId: string,
  request: typeof fetch = fetch,
) {
  workspace = resolve(workspace);
  async function call(route: string, body?: unknown) {
    try {
      if (!(await lstat(workspace)).isDirectory()) throw new Error('Invalid workspace');
      const read = async (path: string) => {
        await checkDestinationPath(workspace, path);
        const file = await open(
          join(workspace, path),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 4096) throw new Error('Invalid connection file');
          const buffer = Buffer.alloc(4097);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 4096) throw new Error('Invalid connection metadata');
          return buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
          await file.close();
        }
      };
      const connection = JSON.parse(await read('.repo-cloak/agent/connection.json')) as {
        protocol?: number;
        workspaceId?: string;
        baseUrl?: string;
      };
      if (connection.protocol !== 1 || connection.workspaceId !== workspaceId)
        throw new Error('Wrong workspace');
      if (!connection.baseUrl || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(connection.baseUrl))
        throw new Error('Offline');
      const token = (await read('.repo-cloak/agent/token')).trim();
      if (token.split('.')[0] !== workspaceId || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(token))
        throw new Error('Invalid scoped token');
      const response = await request(`${connection.baseUrl}/agent/v1/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error('Unavailable');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new Error('Response too large');
        }
        chunks.push(next.value);
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8'))),
          },
        ],
      };
    } catch {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: 'Request unavailable. Open the repo-cloak dashboard to check this workspace connection and profile/repository exclusions.',
          },
        ],
      };
    }
  }
  const paths = z.array(z.string().min(1).max(1024)).min(1);
  const tools: McpTool[] = [
    {
      name: 'cloak_workspace_info',
      description: 'Get this cloak workspace identity, connection and public limits.',
      input: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: () => call('info'),
    },
    {
      name: 'cloak_probe_files',
      description: 'Probe exact anonymized paths; availability never grants access.',
      input: z.object({ paths: paths.max(100) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (input: unknown) => call('probe', input),
    },
    {
      name: 'cloak_request_files',
      description:
        'Queue necessary files for owner approval. Tell the user the returned request ID and wait for pulled status.',
      input: z.object({
        paths: paths.max(20),
        reason: z.string().min(1).max(500),
        clientRequestId: z.string().min(1).max(100),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: (input: unknown) => call('requests', input),
    },
    {
      name: 'cloak_request_status',
      description: 'Check per-file status for a request in this workspace.',
      input: z.object({ requestId: z.uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: ({ requestId }: { requestId: string }) => call(`requests/${requestId}`),
    },
  ];
  return createMcpServer({
    name: 'repo-cloak',
    version,
    instructions:
      'This is an anonymized selected workspace. Probe exact anonymized paths, request only necessary files, tell the user the request ID and wait for dashboard approval. No approval, source search, raw read, pull or push tool exists.',
    tools,
    maxInputElements: 250,
    maxMessageBytes: 1024 * 1024,
  });
}
export async function runAgentMcp(workspace: string, workspaceId: string) {
  await createAgentMcp(workspace, workspaceId).connect(process.stdin, process.stdout);
}
