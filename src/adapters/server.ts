import { browseFolders } from './folders.js';
import { OperationError } from './ui-operations.js';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Dashboard } from '../application/dashboard.js';
import { documentKinds, jsonSchema } from '../core/schemas.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
]);
class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
    throw new RequestError(415, 'Use application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > 1024 * 1024) throw new RequestError(413, 'Request body exceeds 1 MB');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (cause) {
    throw new RequestError(400, 'Invalid JSON', { cause });
  }
}

export function createDashboardServer(
  dashboard: Dashboard,
  token: string,
  assetRoot = fileURLToPath(new URL('./ui/', import.meta.url)),
) {
  function send(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent)
        send(
          response,
          error instanceof RequestError
            ? error.status
            : error instanceof OperationError
              ? {
                  validation: 400,
                  conflict: 409,
                  stale: 409,
                  expired: 410,
                  busy: 409,
                  limit: 429,
                  unknown: 404,
                }[error.code]
              : 400,
          {
            error: error instanceof Error ? error.message : 'Request failed',
            code: error instanceof OperationError ? error.code : 'validation',
          },
        );
      else response.destroy();
    });
  });
  server.once('close', () => dashboard.sync.close());
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new RequestError(503, 'Server is not ready');
    const host = `127.0.0.1:${address.port}`;
    const base = new URL(`http://${host}`);
    if (
      (request.headers.host !== host && request.headers.host !== base.host) ||
      (request.headers.origin && request.headers.origin !== base.origin)
    )
      throw new RequestError(403, 'Foreign Host or Origin');
    const url = new URL(request.url ?? '/', `http://${host}`);
    const method = request.method ?? 'GET';
    if (!url.pathname.startsWith('/api/')) {
      const asset = assets.get(url.pathname);
      if (!asset || method !== 'GET') throw new RequestError(404, 'Not found');
      const [name, type] = asset;
      const bytes = await readFile(join(assetRoot, name ?? ''));
      response.writeHead(200, { 'Content-Type': type ?? 'application/octet-stream' });
      response.end(bytes);
      return;
    }
    const supplied = request.headers.authorization;
    const expected = `Bearer ${token}`;
    if (
      typeof supplied !== 'string' ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      throw new RequestError(401, 'Session token required');
    let result: unknown;
    if (method === 'GET' && url.pathname === '/api/session')
      result = { app: 'repo-cloak', protocol: 1, pid: process.pid };
    else if (method === 'GET' && url.pathname === '/api/settings')
      result = await dashboard.settings.read();
    else if (method === 'PUT' && url.pathname === '/api/settings')
      result = await dashboard.settings.save(await readBody(request));
    else if (method === 'GET' && url.pathname === '/api/folders') {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new RequestError(400, 'Invalid folder offset');
      result = await browseFolders(url.searchParams.get('path') ?? undefined, offset);
    } else if (method === 'GET' && url.pathname === '/api/repos')
      result = await dashboard.overview();
    else if (method === 'POST' && url.pathname === '/api/repos')
      result = await dashboard.addRepository(await readBody(request));
    else if (method === 'GET' && /^\/api\/repos\/[^/]+\/worktrees$/.test(url.pathname))
      result = await dashboard.sync.worktrees(decodeURIComponent(url.pathname.split('/')[3] ?? ''));
    else if (method === 'GET' && /^\/api\/repos\/[^/]+\/commits$/.test(url.pathname))
      result = await dashboard.sync.commits(
        decodeURIComponent(url.pathname.split('/')[3] ?? ''),
        url.searchParams.get('worktree') ?? '',
        url.searchParams.get('offset') ?? 0,
        url.searchParams.get('ref') ?? undefined,
      );
    else if (/^\/api\/repos\/[^/]+\/exclusions$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
      if (method === 'GET') result = await dashboard.sync.exclusions(id);
      else if (method === 'PUT')
        result = await dashboard.sync.saveExclusions(id, await readBody(request));
      else throw new RequestError(404, 'Not found');
    } else if (method === 'GET' && /^\/api\/repos\/[^/]+\/inventory$/.test(url.pathname)) {
      const respect = url.searchParams.get('respectGitIgnore') ?? 'true';
      if (respect !== 'true' && respect !== 'false')
        throw new RequestError(400, 'Invalid Git ignore preference');
      result = await dashboard.sync.inventory(
        decodeURIComponent(url.pathname.split('/')[3] ?? ''),
        url.searchParams.get('worktree') ?? '',
        JSON.parse(url.searchParams.get('profiles') ?? '[]') as unknown,
        respect === 'true',
      );
    } else if (/^\/api\/repos\/[^/]+\/workspaces\/[^/]+\/export-commits$/.test(url.pathname)) {
      if (method !== 'GET') throw new RequestError(404, 'Not found');
      const parts = url.pathname.split('/');
      result = await dashboard.sync.exportCommits(
        decodeURIComponent(parts[3] ?? ''),
        decodeURIComponent(parts[5] ?? ''),
        url.searchParams.get('offset') ?? 0,
        url.searchParams.get('ref') ?? undefined,
      );
    } else if (/^\/api\/repos\/[^/]+\/workspaces\/[^/]+\/export$/.test(url.pathname)) {
      if (method !== 'POST') throw new RequestError(404, 'Not found');
      const parts = url.pathname.split('/');
      result = await dashboard.sync.exportDiff(
        decodeURIComponent(parts[3] ?? ''),
        decodeURIComponent(parts[5] ?? ''),
        await readBody(request),
      );
    } else if (/^\/api\/repos\/[^/]+\/workspaces\/[^/]+\/export-files$/.test(url.pathname)) {
      if (method !== 'POST') throw new RequestError(404, 'Not found');
      const parts = url.pathname.split('/');
      result = await dashboard.sync.exportFiles(
        decodeURIComponent(parts[3] ?? ''),
        decodeURIComponent(parts[5] ?? ''),
        await readBody(request),
      );
    } else if (method === 'GET' && /^\/api\/repos\/[^/]+\/selection-context$/.test(url.pathname))
      result = await dashboard.sync.selectionContext(
        decodeURIComponent(url.pathname.split('/')[3] ?? ''),
        url.searchParams.get('worktree') ?? '',
        JSON.parse(url.searchParams.get('profiles') ?? '[]') as unknown,
      );
    else if (method === 'GET' && /^\/api\/repos\/[^/]+\/selection$/.test(url.pathname))
      result = await dashboard.sync.selection(
        decodeURIComponent(url.pathname.split('/')[3] ?? ''),
        url.searchParams.get('worktree') ?? '',
        Number(url.searchParams.get('offset') ?? '0'),
        url.searchParams.get('query') ?? '',
        JSON.parse(url.searchParams.get('profiles') ?? '[]') as unknown,
        url.searchParams.get('directory') ?? undefined,
      );
    else if (method === 'POST' && url.pathname === '/api/sync/preview')
      result = await dashboard.sync.preview(await readBody(request));
    else if (/^\/api\/sync\/[^/]+(?:\/apply)?$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
      if (method === 'POST' && url.pathname.endsWith('/apply'))
        result = await dashboard.sync.apply(id, await readBody(request));
      else if (method === 'GET' && !url.pathname.endsWith('/apply'))
        result = dashboard.sync.status(id);
      else if (method === 'DELETE' && !url.pathname.endsWith('/apply'))
        result = dashboard.sync.cancel(id);
      else throw new RequestError(404, 'Not found');
    } else if (method === 'GET' && url.pathname === '/api/profiles')
      result = await dashboard.profiles(url.searchParams.get('repoId') ?? undefined);
    else if (method === 'POST' && url.pathname === '/api/profiles')
      result = await dashboard.saveProfile(await readBody(request));
    else if (method === 'DELETE' && url.pathname === '/api/profiles')
      result = await dashboard.deleteProfile(await readBody(request));
    else if (method === 'POST' && url.pathname === '/api/profiles/validate')
      result = dashboard.validateProfile(await readBody(request));
    else if (method === 'POST' && url.pathname === '/api/profiles/check')
      result = await dashboard.checkProfiles(await readBody(request));
    else if (
      (method === 'GET' || method === 'DELETE') &&
      /^\/api\/workspaces\/[^/]+\/[^/]+$/.test(url.pathname)
    ) {
      const parts = url.pathname.split('/');
      result =
        method === 'DELETE'
          ? await dashboard.deleteWorkspace(
              decodeURIComponent(parts[3] ?? ''),
              decodeURIComponent(parts[4] ?? ''),
              await readBody(request),
            )
          : await dashboard.workspace(
              decodeURIComponent(parts[3] ?? ''),
              decodeURIComponent(parts[4] ?? ''),
            );
    } else if (method === 'GET' && url.pathname.startsWith('/api/schema/')) {
      const kind = documentKinds.find((kind) => kind === url.pathname.slice('/api/schema/'.length));
      if (!kind) throw new RequestError(404, 'Unknown schema');
      result = jsonSchema(kind);
    } else throw new RequestError(404, 'Not found');
    send(response, 200, result);
  }
  return server;
}
