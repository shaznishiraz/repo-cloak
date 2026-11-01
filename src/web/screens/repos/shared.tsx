import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Inputs } from 'preact/hooks';
import type { GuardCheck } from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { Button, toast } from '../../shell/ui/index.js';
import './admin.css';

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Request failed';
}

type Loaded<T> = { data: T | null; error: string | null; loading: boolean };
/** Loads on mount and when `inputs` change, dropping any answer a newer load has replaced. */
export function useLoad<T>(load: () => Promise<T>, inputs: Inputs) {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: true });
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const id = ++latest.current;
    setState((current) => ({ ...current, loading: true }));
    try {
      const data = await load();
      if (id === latest.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === latest.current)
        setState((current) => ({ ...current, error: errorText(error), loading: false }));
    }
    // The caller's inputs stand in for `load`, which is a new function every render.
  }, inputs);
  useEffect(() => {
    // New inputs mean a different subject: never leave the old one's data, or its buttons, up.
    setState({ data: null, error: null, loading: true });
    void reload();
  }, [reload]);
  const set = useCallback((data: T) => {
    latest.current++;
    setState({ data, error: null, loading: false });
  }, []);
  return { ...state, reload, set };
}

/** Short age for tight columns: 40m, 5h, 3d, 2mo. */
export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return '—';
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`, 'ok');
  } catch {
    toast(`Could not copy ${what}; select it and copy by hand`, 'error');
  }
}

export function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function LoadError({ message }: { message: string | null }) {
  return message ? (
    <p class="adm-error" role="alert">
      {message}
    </p>
  ) : null;
}

const glyphs: Record<GuardCheck['state'], string> = {
  ok: '✓',
  warning: '!',
  blocked: '✕',
  info: '·',
};
export function CheckList({ checks }: { checks: GuardCheck[] }) {
  return (
    <ul class="adm-checks">
      {checks.map((check) => (
        <li key={check.id} class={`adm-check adm-check-${check.state}`}>
          <span class="adm-check-glyph" aria-hidden="true">
            {glyphs[check.state]}
          </span>
          <span>
            {check.title} {check.detail && <span class="adm-meta-mono">{check.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function parentOf(path: string) {
  const parent = path.replace(/[/\\][^/\\]+[/\\]?$/, '');
  return parent && parent !== path ? parent : /^[/\\]/.test(path) ? path.slice(0, 1) : path;
}

/** Browses folders on this machine; typing the path still works if the listing fails. */
export function FolderPicker({
  start,
  onPick,
}: {
  start?: string | undefined;
  onPick: (path: string) => void;
}) {
  const [path, setPath] = useState(start || undefined);
  const listing = useLoad(
    () => api().call('GET /api/v2/folders', { query: path ? { path } : {} }),
    [path],
  );
  const current = listing.data?.path ?? path;
  return (
    <div class="adm-picker">
      {listing.error && (
        <p class="adm-error" role="alert">
          Could not list folders: {listing.error}. Type the path instead.
        </p>
      )}
      {listing.data && (
        <>
          <div class="adm-picker-head">
            <span class="adm-mono-cut">{listing.data.path}</span>
            <Button size="small" onClick={() => setPath(parentOf(listing.data?.path ?? ''))}>
              Up
            </Button>
            <Button size="small" onClick={() => current && onPick(current)}>
              Use this folder
            </Button>
          </div>
          <ul class="adm-picker-list" aria-label="Folders">
            {listing.data.folders.map((folder) => (
              <li key={folder.path}>
                <button type="button" class="adm-picker-item" onClick={() => setPath(folder.path)}>
                  {folder.name}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
