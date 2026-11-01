import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpServer } from '../../src/adapters/mcp-stdio.js';

function server(maxMessageBytes = 4096) {
  return createMcpServer({
    name: 'test',
    version: '1.2.3',
    instructions: 'be careful',
    maxInputElements: 5,
    maxMessageBytes,
    tools: [
      {
        name: 'echo',
        description: 'Echo',
        input: z.object({ value: z.array(z.string()).optional() }),
        annotations: { readOnlyHint: true },
        run: async (input: unknown) => ({
          content: [{ type: 'text', text: JSON.stringify(input) }],
        }),
      },
      {
        name: 'boom',
        description: 'Throws',
        input: z.object({}),
        annotations: {},
        run: async () => {
          throw new Error('secret detail');
        },
      },
    ],
  });
}
const request = (method: string, params?: unknown, id: unknown = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

it('negotiates the protocol version and advertises tools', async () => {
  const { handleLine } = server();
  expect(
    await handleLine(request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })),
  ).toEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'test', version: '1.2.3' },
      instructions: 'be careful',
    },
  });
  const future = (await handleLine(request('initialize', { protocolVersion: '2099-01-01' }))) as {
    result: { protocolVersion: string };
  };
  expect(future.result.protocolVersion).toBe('2025-11-25');
  expect(await handleLine(request('initialize', {}))).toMatchObject({
    error: { code: -32602 },
  });
});

it('answers ping, stays silent on notifications and drops client replies', async () => {
  const { handleLine } = server();
  expect(await handleLine(request('ping'))).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  expect(
    await handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
  ).toBeUndefined();
  expect(await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, result: {} }))).toBeUndefined();
});

it('reports protocol errors with the right JSON-RPC codes', async () => {
  const { handleLine } = server();
  expect(await handleLine('{nope')).toMatchObject({ id: null, error: { code: -32700 } });
  expect(await handleLine('[]')).toMatchObject({ id: null, error: { code: -32600 } });
  expect(await handleLine(JSON.stringify({ id: 7, method: 'ping' }))).toMatchObject({
    id: 7,
    error: { code: -32600 },
  });
  expect(await handleLine(request('resources/list'))).toMatchObject({
    error: { code: -32601 },
  });
  expect(await handleLine(request('tools/call', { arguments: {} }))).toMatchObject({
    error: { code: -32602 },
  });
});

it('lists JSON Schema and runs validated tool calls', async () => {
  const { handleLine } = server();
  const list = (await handleLine(request('tools/list'))) as {
    result: { tools: { name: string; inputSchema: Record<string, unknown> }[] };
  };
  expect(list.result.tools.map((tool) => tool.name)).toEqual(['echo', 'boom']);
  expect(list.result.tools[0]?.inputSchema.type).toBe('object');
  expect(list.result.tools[0]?.inputSchema.$schema).toBeUndefined();
  const call = (name: string, args: unknown) =>
    handleLine(request('tools/call', { name, arguments: args }));
  expect(await call('echo', { value: ['a'], ignored: 1 })).toMatchObject({
    result: { content: [{ text: '{"value":["a"]}' }] },
  });
  expect(await call('echo', { value: 'wrong' })).toMatchObject({ result: { isError: true } });
  expect(await call('nope', {})).toMatchObject({ result: { isError: true } });
  expect(await call('echo', { value: ['1', '2', '3', '4', '5', '6'] })).toMatchObject({
    result: { isError: true, content: [{ text: expect.stringContaining('too many') }] },
  });
});

it('never exposes the message of an unexpected internal failure', async () => {
  const reply = await server().handleLine(request('tools/call', { name: 'boom' }));
  expect(reply).toMatchObject({ error: { code: -32603, message: 'Internal error' } });
  expect(JSON.stringify(reply)).not.toContain('secret detail');
});

it('frames split, combined and CRLF-terminated messages over a stream', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = server().connect(input, output);
  const replies: { id: number }[] = [];
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    text += chunk;
  });
  const first = request('ping', undefined, 1);
  input.write(first.slice(0, 5));
  input.write(`${first.slice(5)}\r\n${request('ping', undefined, 2)}\n\n`);
  input.end();
  await done;
  for (const line of text.trim().split('\n')) replies.push(JSON.parse(line) as { id: number });
  expect(replies.map((reply) => reply.id).sort()).toEqual([1, 2]);
});

it.each([
  ['an unterminated message', 'x'.repeat(200)],
  ['a complete message', `${'x'.repeat(200)}\n`],
])('ends the session on %s over the size limit', async (_name, content) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = server(100).connect(input, output);
  input.write(content);
  await expect(done).rejects.toThrow(/exceeds 100 bytes/);
});
