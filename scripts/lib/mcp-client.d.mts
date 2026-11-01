import type { Readable, Writable } from 'node:stream';

export type McpReply = {
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string };
};
export function createMcpClient(
  input: Writable,
  output: Readable,
): {
  raw(method: string, params?: unknown): Promise<McpReply>;
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  initialize(protocolVersion?: string): Promise<{
    protocolVersion: string;
    capabilities: unknown;
    serverInfo: { name: string; version: string };
    instructions: string;
  }>;
  listTools(): Promise<{
    tools: { name: string; description: string; inputSchema: unknown; annotations: unknown }[];
  }>;
  callTool(
    name: string,
    args?: unknown,
  ): Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;
};
