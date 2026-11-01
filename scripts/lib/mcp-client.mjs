/** Tiny newline-delimited JSON-RPC client, used to smoke test the MCP server without an SDK. */
export function createMcpClient(input, output) {
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  output.setEncoding?.('utf8');
  output.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end === -1) break;
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const send = (message) => input.write(`${JSON.stringify(message)}\n`);
  const raw = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    });
  const request = async (method, params) => {
    const reply = await raw(method, params);
    if (reply.error) throw new Error(`${method}: ${reply.error.code} ${reply.error.message}`);
    return reply.result;
  };
  return {
    raw,
    request,
    notify: (method, params) => send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }),
    async initialize(protocolVersion = '2025-11-25') {
      const result = await request('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'repo-cloak-smoke', version: '1' },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return result;
    },
    listTools: () => request('tools/list'),
    callTool: (name, args = {}) => request('tools/call', { name, arguments: args }),
  };
}
