import { ApiError } from '../../api/client.js';
import { api } from '../../shell/load.js';
import { overview } from '../../shell/state.js';
import { toast } from '../../shell/ui/index.js';

export function errorText(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return 'Request failed';
}
export function reportError(error: unknown) {
  toast(errorText(error), 'error');
}

/** Screens refresh the shell's counts after an action. The launch chip keeps its context. */
export async function refreshOverview() {
  const fresh = await api().call('GET /api/v2/overview');
  overview.value = { ...fresh, launch: overview.value?.launch ?? fresh.launch };
}

export async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`, 'ok');
  } catch {
    toast(`Could not copy. ${label}: ${text}`, 'error');
  }
}

export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/x-patch;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Runs a request so that a tab with no session reports an error instead of throwing. */
export const request = <T>(call: () => Promise<T>) => Promise.resolve().then(call);

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
