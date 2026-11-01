// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { poll } from '../../src/web/api/client.js';

function setHidden(value: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value });
}
afterEach(() => {
  setHidden(false);
  vi.useRealTimers();
});

it('loads once in a background tab, then refreshes as soon as the tab is shown', async () => {
  vi.useFakeTimers();
  setHidden(true);
  const load = vi.fn(async () => 1);
  const stop = poll(load, { onData: () => {}, onError: () => {} }, 1000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(1);
  setHidden(false);
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(load).toHaveBeenCalledTimes(3);
  stop();
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(3);
});
