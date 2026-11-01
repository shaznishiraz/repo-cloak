import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';

/** A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0. Tools only. */
export type McpContent = { type: 'text'; text: string };
export type McpToolResult = { content: McpContent[]; isError?: boolean };
export type McpTool = {
  name: string;
  description: string;
  input: z.ZodType;
  annotations: Record<string, boolean>;
  run: (input: never) => Promise<McpToolResult>;
};
export type McpServerOptions = {
  name: string;
  version: string;
  instructions: string;
  tools: McpTool[];
  /** Largest number of values accepted across a tool call's arguments. */
  maxInputElements: number;
  /** Largest accepted message, before any of it is parsed. */
  maxMessageBytes: number;
};

const supportedVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const parseError = -32700;
const invalidRequest = -32600;
const methodNotFound = -32601;
const invalidParams = -32602;
const internalError = -32603;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
const requestSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
const callSchema = z.looseObject({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
const initializeSchema = z.looseObject({ protocolVersion: z.string() });

function countElements(value: unknown, limit: number): number {
  let count = 0;
  const pending = [value];
  while (pending.length && count <= limit) {
    const next = pending.pop();
    if (!next || typeof next !== 'object') continue;
    const children = Array.isArray(next) ? next : Object.values(next);
    count += children.length;
    pending.push(...children);
  }
  return count;
}
function describeTool(tool: McpTool) {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(tool.input, { io: 'input' });
  void _schema;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    annotations: tool.annotations,
  };
}

export function createMcpServer(options: McpServerOptions) {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const listed = options.tools.map(describeTool);

  async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'ping') return {};
    if (method === 'initialize') {
      const parsed = initializeSchema.safeParse(params);
      if (!parsed.success) throw new RpcError(invalidParams, 'Invalid initialize parameters');
      const requested = parsed.data.protocolVersion;
      return {
        protocolVersion: supportedVersions.includes(requested) ? requested : supportedVersions[0],
        capabilities: { tools: {} },
        serverInfo: { name: options.name, version: options.version },
        instructions: options.instructions,
      };
    }
    if (method === 'tools/list') return { tools: listed };
    if (method === 'tools/call') {
      const call = callSchema.safeParse(params);
      if (!call.success) throw new RpcError(invalidParams, 'Invalid tool call');
      const tool = tools.get(call.data.name);
      if (!tool) return toolError(`Tool ${call.data.name} not found`);
      const args = call.data.arguments ?? {};
      if (countElements(args, options.maxInputElements) > options.maxInputElements)
        return toolError(`Invalid arguments for tool ${tool.name}: too many elements`);
      const input = tool.input.safeParse(args);
      if (!input.success) return toolError(`Invalid arguments for tool ${tool.name}`);
      return tool.run(input.data as never);
    }
    throw new RpcError(methodNotFound, 'Method not found');
  }
  function toolError(text: string): McpToolResult {
    return { isError: true, content: [{ type: 'text', text }] };
  }
  /** Handles one raw line and returns the reply to send, if the message expects one. */
  async function handleLine(line: string): Promise<unknown> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return { jsonrpc: '2.0', id: null, error: { code: parseError, message: 'Parse error' } };
    }
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success) {
      // Replies from a client carry no method; this server never asks anything, so drop them.
      if (message && typeof message === 'object' && ('result' in message || 'error' in message))
        return undefined;
      const id = (message as { id?: unknown } | null)?.id;
      return {
        jsonrpc: '2.0',
        id: typeof id === 'string' || typeof id === 'number' ? id : null,
        error: { code: invalidRequest, message: 'Invalid request' },
      };
    }
    const { id, method, params } = parsed.data;
    if (id === undefined) return undefined; // Notifications, including notifications/initialized.
    try {
      return { jsonrpc: '2.0', id, result: await dispatch(method, params ?? {}) };
    } catch (error) {
      const known = error instanceof RpcError;
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: known ? error.code : internalError,
          message: known ? error.message : 'Internal error',
        },
      };
    }
  }
  /** Serves until input ends. Replies may finish out of order; JSON-RPC ids pair them up. */
  function connect(input: Readable, output: Writable): Promise<void> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let inFlight = 0;
      let ended = false;
      const finish = () => {
        if (ended && !inFlight) resolve();
      };
      const respond = (line: string) => {
        inFlight += 1;
        void handleLine(line)
          .then((reply) => {
            if (reply !== undefined) output.write(`${JSON.stringify(reply)}\n`);
          })
          .finally(() => {
            inFlight -= 1;
            finish();
          });
      };
      input.on('data', (chunk: Buffer | string) => {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        for (;;) {
          const end = buffer.indexOf(0x0a);
          if (end === -1 || end > options.maxMessageBytes) break;
          const line = buffer.toString('utf8', 0, end).replace(/\r$/, '');
          buffer = buffer.subarray(end + 1);
          if (line.trim()) respond(line);
        }
        if (buffer.length > options.maxMessageBytes) {
          // The rest of this message cannot be framed safely, so end the session.
          input.destroy();
          reject(new Error(`Message exceeds ${options.maxMessageBytes} bytes`));
        }
      });
      input.on('end', () => {
        ended = true;
        finish();
      });
      input.on('error', reject);
    });
  }
  return { handleLine, connect };
}
