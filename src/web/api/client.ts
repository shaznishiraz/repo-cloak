import type { RouteParams, SupplyChainReport, V2Api, V2Route } from './contracts.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

type PathOf<K extends string> = K extends `${string} ${infer Path}` ? Path : never;
type MethodOf<K extends string> = K extends `${infer Method} ${string}` ? Method : never;
type Optional<Name extends string, Value> = [Value] extends [never]
  ? { [P in Name]?: never }
  : { [P in Name]: Value };
export type CallOptions<K extends V2Route> = Optional<
  'params',
  RouteParams<PathOf<K>> extends never ? never : Record<RouteParams<PathOf<K>>, string>
> &
  Optional<'body', V2Api[K]['body']> & {
    query?: V2Api[K]['query'] extends never ? never : V2Api[K]['query'];
  };

export function createClient(token: string, request: typeof fetch = (...args) => fetch(...args)) {
  async function call<K extends V2Route>(
    route: K,
    ...[options]: [V2Api[K]['body'], RouteParams<PathOf<K>>] extends [never, never]
      ? [options?: CallOptions<K>]
      : [options: CallOptions<K>]
  ): Promise<V2Api[K]['response']> {
    const [method, template] = route.split(' ') as [MethodOf<K>, string];
    const params = (options?.params ?? {}) as Record<string, string>;
    const path = template.replace(/:(\w+)/g, (_match, name: string) => {
      const value = params[name];
      if (value === undefined) throw new Error(`Missing route parameter ${name}`);
      return encodeURIComponent(value);
    });
    const search = new URLSearchParams(
      Object.entries((options?.query ?? {}) as Record<string, string | undefined>).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ).toString();
    const hasBody = options?.body !== undefined;
    const response = await request(`${path}${search ? `?${search}` : ''}`, {
      method,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ApiError(response.status, 'The dashboard returned an unreadable response');
    }
    if (!response.ok) {
      const failure = (value ?? {}) as { error?: string; code?: string };
      throw new ApiError(
        response.status,
        failure.error ?? `Request failed (${response.status})`,
        failure.code,
      );
    }
    return value as V2Api[K]['response'];
  }
  return { call };
}
export type ApiClient = ReturnType<typeof createClient>;

/** Generated at build time and served with the page, so it needs no session token. */
export async function loadSupplyChain(
  request: typeof fetch = (...args) => fetch(...args),
): Promise<SupplyChainReport> {
  const response = await request('/supply-chain.json');
  if (!response.ok) throw new ApiError(response.status, 'Supply chain report unavailable');
  return (await response.json()) as SupplyChainReport;
}

/**
 * Refreshes on an interval without overlapping requests, and pauses while the tab is hidden.
 * Polling rather than SSE: the server keeps its short request timeouts.
 */
export function poll<T>(
  load: () => Promise<T>,
  handlers: { onData: (value: T) => void; onError: (error: unknown) => void },
  intervalMs = 15_000,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function tick() {
    if (stopped) return;
    if (!globalThis.document?.hidden) {
      try {
        const value = await load();
        if (!stopped) handlers.onData(value);
      } catch (error) {
        if (!stopped) handlers.onError(error);
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  }
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
