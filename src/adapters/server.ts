import { OperationError } from './ui-operations.js';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import type { Dashboard } from '../application/dashboard.js';
import { RequestError, matchRoute, readBody } from './server-v2/router.js';
import { v2Routes } from './server-v2/index.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/favicon.ico', ['favicon.ico', 'image/x-icon']],
  ['/supply-chain.json', ['supply-chain.json', 'application/json; charset=utf-8']],
]);
/** Schema errors stringify to raw JSON, which would reach the user as a toast. */
function errorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return `Invalid request: ${[...(issue?.path ?? []), issue?.message].join(': ')}`;
  }
  return error instanceof Error ? error.message : 'Request failed';
}
export function createDashboardServer(dashboard: Dashboard, token: string, assetRoot?: string) {
  const assetDirectory = assetRoot ?? fileURLToPath(new URL('./web/', import.meta.url));
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
            error: errorMessage(error),
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
    if (url.pathname.startsWith('/agent/')) {
      if (request.headers.origin)
        throw new RequestError(403, 'Agent clients must use a direct local connection');
      try {
        const header = request.headers.authorization ?? '';
        const doc = await dashboard.agents.authenticate(
          header.startsWith('Bearer ') ? header.slice(7) : '',
        );
        if (!doc) {
          send(response, 401, { error: 'Scoped workspace credential required' });
          return;
        }
        const route = url.pathname.slice('/agent/v1/'.length);
        const requestId = route.startsWith('requests/') ? route.slice(9) : undefined;
        if (
          !url.pathname.startsWith('/agent/v1/') ||
          !(
            (method === 'POST' && ['probe', 'requests'].includes(route)) ||
            (method === 'GET' && (route === 'info' || /^[a-f0-9-]{36}$/.test(requestId ?? '')))
          )
        ) {
          send(response, 404, { error: 'Agent route unavailable' });
          return;
        }
        send(
          response,
          200,
          await dashboard.agents.agentCall(
            doc,
            requestId ?? route,
            method === 'POST' ? await readBody(request) : {},
          ),
        );
      } catch {
        send(response, 400, {
          error:
            'Agent request unavailable; check input, connection or exclusions in the dashboard',
        });
      }
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      const asset = assets.get(url.pathname);
      if (!asset || method !== 'GET') throw new RequestError(404, 'Not found');
      const [name, type] = asset;
      const bytes = await readFile(join(assetDirectory, name ?? ''));
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
    if (url.pathname.startsWith('/api/v2/')) {
      const found = matchRoute(v2Routes, method, url.pathname);
      if (!found) throw new RequestError(404, 'Not found');
      send(
        response,
        200,
        await found.route.handler({
          dashboard,
          port: address.port,
          params: found.params,
          query: url.searchParams,
          body: () => readBody(request),
        }),
      );
      return;
    }
    // The launcher authenticates a running server through this before reusing it.
    if (method === 'GET' && url.pathname === '/api/session') {
      send(response, 200, { app: 'repo-cloak', protocol: 1, pid: process.pid });
      return;
    }
    throw new RequestError(404, 'Not found');
  }
  return server;
}
