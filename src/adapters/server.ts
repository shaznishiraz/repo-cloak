import { browseFolders } from './folders.js';
import { OperationError } from './ui-operations.js';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Dashboard } from '../application/dashboard.js';
import { z } from 'zod';
import { RequestError, matchRoute, readBody } from './server-v2/router.js';
import { v2Routes } from './server-v2/index.js';
import type { UiKind } from '../web/api/contracts.js';
import { documentKinds, jsonSchema } from '../core/schemas.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/favicon.ico', ['favicon.ico', 'image/x-icon']],
]);
export function createDashboardServer(
  dashboard: Dashboard,
  token: string,
  assetRoot?: string,
  ui: UiKind = 'classic',
) {
  const assetDirectory =
    assetRoot ?? fileURLToPath(new URL(ui === 'next' ? './web/' : './ui/', import.meta.url));
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
          ui,
          port: address.port,
          params: found.params,
          query: url.searchParams,
          body: () => readBody(request),
        }),
      );
      return;
    }
    let result: unknown;
    if (method === 'GET' && url.pathname === '/api/session')
      result = { app: 'repo-cloak', protocol: 1, pid: process.pid, ui };
    else if (method === 'GET' && url.pathname === '/api/settings')
      result = await dashboard.settings.read();
    else if (method === 'GET' && url.pathname === '/api/desktop')
      result = await dashboard.desktop.availability();
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
    else if (method === 'DELETE' && /^\/api\/repos\/[^/]+$/.test(url.pathname))
      result = await dashboard.removeRepository(
        decodeURIComponent(url.pathname.split('/')[3] ?? ''),
      );
    else if (url.pathname === '/api/groups') {
      if (method === 'GET') result = await dashboard.groups.list();
      else if (method === 'POST') result = await dashboard.groups.save(await readBody(request));
      else throw new RequestError(404, 'Not found');
    } else if (method === 'POST' && /^\/api\/groups\/[^/]+\/open$/.test(url.pathname))
      result = await dashboard.desktop.openGroup(
        decodeURIComponent(url.pathname.split('/')[3] ?? ''),
        await readBody(request),
      );
    else if (method === 'POST' && /^\/api\/workspaces\/[^/]+\/[^/]+\/open$/.test(url.pathname))
      result = await dashboard.desktop.openWorkspace(
        decodeURIComponent(url.pathname.split('/')[3] ?? ''),
        decodeURIComponent(url.pathname.split('/')[4] ?? ''),
        await readBody(request),
      );
    else if (/^\/api\/groups\/[^/]+(?:\/preview)?$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
      if (method === 'POST' && url.pathname.endsWith('/preview'))
        result = await dashboard.groups.preview(id, await readBody(request));
      else if (!url.pathname.endsWith('/preview') && method === 'PUT') {
        const { revision, group } = z
          .object({ revision: z.string().min(1), group: z.unknown() })
          .strict()
          .parse(await readBody(request));
        result = await dashboard.groups.save(group, id, revision);
      } else if (!url.pathname.endsWith('/preview') && method === 'DELETE') {
        const { revision } = z
          .object({ revision: z.string().min(1) })
          .strict()
          .parse(await readBody(request));
        result = await dashboard.groups.remove(id, revision);
      } else throw new RequestError(404, 'Not found');
    } else if (/^\/api\/group-sync\/[^/]+(?:\/(?:apply|retry))?$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
      if (method === 'POST' && url.pathname.endsWith('/apply'))
        result = await dashboard.groups.apply(id, await readBody(request));
      else if (method === 'POST' && url.pathname.endsWith('/retry'))
        result = await dashboard.groups.retry(id);
      else if (method === 'GET' && url.pathname.split('/').length === 4)
        result = dashboard.groups.status(id);
      else if (method === 'DELETE' && url.pathname.split('/').length === 4)
        result = dashboard.groups.cancel(id);
      else throw new RequestError(404, 'Not found');
    } else if (method === 'GET' && /^\/api\/repos\/[^/]+\/worktrees$/.test(url.pathname))
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
    else if (/^\/api\/workspaces\/[^/]+\/[^/]+\/agent(?:\/.*)?$/.test(url.pathname)) {
      const parts = url.pathname.split('/');
      const repoId = decodeURIComponent(parts[3] ?? '');
      const workspaceId = decodeURIComponent(parts[4] ?? '');
      const suffix = parts.slice(6);
      if (!suffix.length && method === 'GET')
        result = await dashboard.agents.info(repoId, workspaceId);
      else if (!suffix.length && method === 'PUT')
        result = await dashboard.agents.configure(repoId, workspaceId, await readBody(request));
      else if (suffix[0] === 'requests' && suffix.length === 3 && method === 'POST') {
        const requestId = decodeURIComponent(suffix[1] ?? '');
        if (suffix[2] === 'preview')
          result = await dashboard.agents.preview(
            repoId,
            workspaceId,
            requestId,
            await readBody(request),
          );
        else if (suffix[2] === 'reject')
          result = await dashboard.agents.reject(
            repoId,
            workspaceId,
            requestId,
            await readBody(request),
          );
        else throw new RequestError(404, 'Not found');
      } else if (
        suffix[0] === 'operations' &&
        suffix[2] === 'apply' &&
        suffix.length === 3 &&
        method === 'POST'
      )
        result = await dashboard.agents.apply(
          repoId,
          workspaceId,
          decodeURIComponent(suffix[1] ?? ''),
        );
      else if (suffix[0] === 'mcp' && suffix.length === 1 && method === 'GET')
        result = await dashboard.agentClientConfig(repoId, workspaceId);
      else if (suffix[0] === 'mcp' && suffix.length === 2 && method === 'POST')
        result = await dashboard.installAgentClient(
          repoId,
          workspaceId,
          suffix[1] ?? '',
          await readBody(request),
        );
      else throw new RequestError(404, 'Not found');
    } else if (/^\/api\/sync\/[^/]+(?:\/apply)?$/.test(url.pathname)) {
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
