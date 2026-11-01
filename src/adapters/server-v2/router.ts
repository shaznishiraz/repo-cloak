import type { IncomingMessage } from 'node:http';
import type { Dashboard } from '../../application/dashboard.js';
import type { V2Api, V2Route } from '../../web/api/contracts.js';

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export async function readBody(request: IncomingMessage): Promise<unknown> {
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

export type RouteContext = {
  dashboard: Dashboard;
  port: number;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Reads and parses the JSON body. Validate it with zod: the type is only a promise. */
  body: () => Promise<unknown>;
};
export type Route = {
  method: string;
  path: string;
  segments: string[];
  handler: (context: RouteContext) => unknown;
};

/** Declares a handler for a contract route, so its response is checked against contracts.ts. */
export function route<K extends V2Route>(
  key: K,
  handler: (context: RouteContext) => V2Api[K]['response'] | Promise<V2Api[K]['response']>,
): Route {
  const [method = '', path = ''] = key.split(' ');
  return { method, path, segments: path.split('/'), handler };
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string) {
  const parts = pathname.split('/');
  for (const candidate of routes) {
    if (candidate.method !== method || candidate.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const matched = candidate.segments.every((segment, index) => {
      const part = parts[index] ?? '';
      if (!segment.startsWith(':')) return segment === part;
      if (!part) return false;
      try {
        params[segment.slice(1)] = decodeURIComponent(part);
      } catch (cause) {
        throw new RequestError(400, 'Invalid request path', { cause });
      }
      return true;
    });
    if (matched) return { route: candidate, params };
  }
  return undefined;
}
