// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FolderListing } from '../../src/web/api/contracts.js';
import { FolderPicker } from '../../src/web/shell/folder-picker.js';
import { startSession } from '../../src/web/shell/load.js';
import { locked } from '../../src/web/shell/state.js';

type Handler = (query: URLSearchParams) => { status?: number; body: unknown };
let root: HTMLElement;
let stop: () => void;
let handler: Handler;
let requested: string[];
const listing = (path: string, names: string[], next: number | null = null): FolderListing => ({
  path,
  folders: names.map((name) => ({ name, path: `${path === '/' ? '' : path}/${name}` })),
  next,
});
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  requested = [];
  handler = (query) => ({ body: listing(query.get('path') ?? '/home', ['alpha', 'beta']) });
  const request = (async (input: string) => {
    const url = new URL(input, 'http://x');
    if (url.pathname !== '/api/v2/folders') return new Response('{"version":"2"}');
    requested.push(`${url.pathname}${url.search}`);
    const { status = 200, body } = handler(url.searchParams);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  stop = startSession({ token: 't', launch: {}, route: '#/' }, request);
});
afterEach(() => {
  stop();
  act(() => render(null, root));
  root.remove();
  locked.value = false;
});
const flush = () => act(() => new Promise<void>((done) => setTimeout(done, 5)));
const button = (name: RegExp | string) =>
  [...root.querySelectorAll('button')].find((item) =>
    typeof name === 'string' ? item.textContent === name : name.test(item.textContent ?? ''),
  );
const alert = () => root.querySelector('[role="alert"]')?.textContent;
const list = () => root.querySelector('ul[aria-label="Folders"]');
const dialogProps = { onClose: () => {} };

for (const [mode, shape] of [
  ['inline', { inline: true as const }],
  ['dialog', dialogProps],
] as const) {
  it(`${mode}: lists under the accessible name and walks down and up`, async () => {
    const onPick = vi.fn();
    act(() => render(<FolderPicker initial="/home" onPick={onPick} {...shape} />, root));
    await flush();
    expect(list()?.textContent).toContain('alpha');
    await act(() => button('beta')?.click());
    await flush();
    expect(requested.at(-1)).toContain(encodeURIComponent('/home/beta'));
    await act(() => button('Parent folder')?.click());
    await flush();
    expect(requested.at(-1)).toBe(`/api/v2/folders?path=${encodeURIComponent('/home')}`);
    await act(() => button('Use this folder')?.click());
    expect(onPick).toHaveBeenCalledWith('/home');
  });

  it(`${mode}: says to type the path when listing fails, and offers no list`, async () => {
    handler = () => ({ status: 400, body: { error: 'Folder is unreadable' } });
    act(() => render(<FolderPicker initial="/nope" onPick={() => {}} {...shape} />, root));
    await flush();
    expect(alert()).toBe('Could not list folders: Folder is unreadable. Type the path instead.');
    expect(list()).toBeNull();
  });

  it(`${mode}: pages through folders without losing the earlier ones`, async () => {
    handler = (query) => ({
      body: query.get('offset')
        ? listing('/home', ['gamma'])
        : listing('/home', ['alpha', 'beta'], 2),
    });
    act(() => render(<FolderPicker onPick={() => {}} {...shape} />, root));
    await flush();
    await act(() => button('More folders')?.click());
    await flush();
    expect(list()?.textContent).toContain('alpha');
    expect(list()?.textContent).toContain('gamma');
    expect(button('More folders')).toBeUndefined();
  });

  it(`${mode}: says when a folder has no subfolders`, async () => {
    handler = () => ({ body: listing('/empty', []) });
    act(() => render(<FolderPicker onPick={() => {}} {...shape} />, root));
    await flush();
    expect(list()?.textContent).toContain('No folders here.');
  });
}

it('dialog: a typed path can still be used after listing fails', async () => {
  handler = () => ({ status: 400, body: { error: 'Folder is unreadable' } });
  const onPick = vi.fn();
  act(() => render(<FolderPicker title="Pick" onPick={onPick} onClose={() => {}} />, root));
  await flush();
  const input = root.querySelector('input') as HTMLInputElement;
  expect(root.querySelector('label')?.textContent).toBe('Folder path');
  await act(() => {
    input.value = '/typed/by/hand';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(() => button('Use this folder')?.click());
  expect(onPick).toHaveBeenCalledWith('/typed/by/hand');
});

it('dialog: Cancel closes without picking', async () => {
  const onPick = vi.fn();
  const onClose = vi.fn();
  act(() => render(<FolderPicker onPick={onPick} onClose={onClose} />, root));
  await flush();
  await act(() => button('Cancel')?.click());
  expect(onClose).toHaveBeenCalledOnce();
  expect(onPick).not.toHaveBeenCalled();
});

it('inline: has no path field of its own and no way to use a folder until one is listed', async () => {
  handler = () => ({ status: 400, body: { error: 'Nope' } });
  act(() => render(<FolderPicker inline onPick={() => {}} />, root));
  await flush();
  expect(root.querySelector('input')).toBeNull();
  expect(button('Use this folder')).toBeUndefined();
});

it('an older answer never replaces a newer one', async () => {
  const answers: ((value: Response) => void)[] = [];
  stop();
  stop = startSession({ token: 't', launch: {}, route: '#/' }, ((input: string) =>
    String(input).startsWith('/api/v2/folders')
      ? new Promise((done) => answers.push(done))
      : Promise.resolve(new Response('{}'))) as unknown as typeof fetch);
  const answer = (index: number, path: string) =>
    answers[index]?.(new Response(JSON.stringify(listing(path, [path.slice(1)]))));
  act(() => render(<FolderPicker onPick={() => {}} onClose={() => {}} />, root));
  await flush();
  answer(0, '/first');
  await flush();
  await act(() => button('first')?.click());
  await act(() => button('Go')?.click());
  await flush();
  answer(2, '/newest');
  await flush();
  answer(1, '/older');
  await flush();
  expect(list()?.textContent).toContain('newest');
  expect(list()?.textContent).not.toContain('older');
});
