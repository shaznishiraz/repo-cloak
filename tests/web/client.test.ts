import { expect, it, vi } from 'vitest';
import { ApiError, createClient, loadSupplyChain, poll } from '../../src/web/api/client.js';

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(
    async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  );
}

it('sends the bearer token, encodes parameters and returns typed JSON', async () => {
  const request = fakeFetch(200, { workspace: {} });
  await createClient('secret', request).call('GET /api/v2/workspaces/:repoId/:id', {
    params: { repoId: 'r 1', id: 'a/b' },
  });
  const [url, init] = request.mock.calls[0] ?? [];
  expect(url).toBe('/api/v2/workspaces/r%201/a%2Fb');
  expect(init?.method).toBe('GET');
  expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  expect(init?.redirect).toBe('error');
});

it('serialises query and JSON bodies', async () => {
  const request = fakeFetch(200, {});
  const client = createClient('t', request);
  await client.call('GET /api/v2/overview', { query: { repo: 'r', worktree: '/a b' } });
  expect(request.mock.calls[0]?.[0]).toBe('/api/v2/overview?repo=r&worktree=%2Fa+b');
  await client.call('POST /api/v2/operations/:id/apply', {
    params: { id: 'o' },
    body: { deletions: true },
  });
  const init = request.mock.calls[1]?.[1];
  expect(init?.body).toBe('{"deletions":true}');
  expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
});

it('turns server failures into ApiError with status and code', async () => {
  const client = createClient('t', fakeFetch(409, { error: 'Preview is stale', code: 'stale' }));
  const failure = await client.call('GET /api/v2/session').catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ status: 409, message: 'Preview is stale', code: 'stale' });
});

it('survives a non-JSON error body', async () => {
  const client = createClient('t', fakeFetch(502, '<html>bad'));
  await expect(client.call('GET /api/v2/session')).rejects.toMatchObject({ status: 502 });
});

it('polls without overlap, reports errors and stops cleanly', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const seen: number[] = [];
    const errors: unknown[] = [];
    const stop = poll(
      async () => {
        calls += 1;
        if (calls === 2) throw new Error('down');
        return calls;
      },
      { onData: (value) => seen.push(value), onError: (error) => errors.push(error) },
      1000,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([1, 3]);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});

it('loads the build-time supply-chain report without a token', async () => {
  const request = fakeFetch(200, { directDependencies: 11 });
  expect(await loadSupplyChain(request)).toEqual({ directDependencies: 11 });
  expect(request.mock.calls[0]).toEqual(['/supply-chain.json']);
  await expect(loadSupplyChain(fakeFetch(404, ''))).rejects.toBeInstanceOf(ApiError);
});
