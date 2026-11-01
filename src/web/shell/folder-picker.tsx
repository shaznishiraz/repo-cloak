import { useEffect, useRef, useState } from 'preact/hooks';
import type { FolderListing } from '../api/contracts.js';
import { api } from './load.js';
import { Button, Dialog, Field } from './ui/index.js';
import './folder-picker.css';

export function parentFolder(path: string) {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return path;
  return cut === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, cut);
}

type Common = { initial?: string | undefined; onPick: (path: string) => void };
/** Inline sits under a path field its parent owns, so typing still works if listing fails. */
type Props = Common & ({ inline: true } | { title?: string; onClose: () => void });

/** Browses local folders through the server, inline or as its own dialog. */
export function FolderPicker({ initial, onPick, ...shape }: Props) {
  const [typed, setTyped] = useState(initial ?? '');
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  async function load(path: string | undefined, offset = 0) {
    const id = ++latest.current;
    setError(null);
    try {
      const next = await api().call('GET /api/v2/folders', {
        query: {
          ...(path ? { path } : {}),
          ...(offset ? { offset: String(offset) } : {}),
        },
      });
      if (id !== latest.current) return;
      setTyped(next.path);
      setListing((current) =>
        offset && current ? { ...next, folders: [...current.folders, ...next.folders] } : next,
      );
    } catch (cause) {
      if (id === latest.current)
        setError(cause instanceof Error ? cause.message : 'Request failed');
    }
  }
  useEffect(() => {
    void load(initial || undefined);
  }, []);

  const parent = (
    <Button
      size="small"
      disabled={!listing}
      onClick={() => listing && void load(parentFolder(listing.path))}
    >
      Parent folder
    </Button>
  );
  const body = (
    <div class={'inline' in shape ? 'picker picker-inline' : 'picker'}>
      {'inline' in shape ? (
        listing && (
          <div class="picker-tools">
            <span class="picker-path">{listing.path}</span>
            {parent}
            <Button size="small" onClick={() => onPick(listing.path)}>
              Use this folder
            </Button>
          </div>
        )
      ) : (
        <>
          <Field
            label="Folder path"
            value={typed}
            onInput={(event) => setTyped(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void load(typed);
            }}
          />
          <div class="picker-tools">
            <Button size="small" onClick={() => void load(typed)}>
              Go
            </Button>
            {parent}
          </div>
        </>
      )}
      {error && (
        <p class="picker-error" role="alert">
          Could not list folders: {error}. Type the path instead.
        </p>
      )}
      {listing && (
        <>
          <ul class="picker-list" aria-label="Folders">
            {listing.folders.map((folder) => (
              <li key={folder.path}>
                <button type="button" class="picker-row" onClick={() => void load(folder.path)}>
                  {folder.name}
                </button>
              </li>
            ))}
            {!listing.folders.length && <li class="muted">No folders here.</li>}
          </ul>
          {listing.next !== null && (
            <Button size="small" onClick={() => void load(listing.path, listing.next ?? 0)}>
              More folders
            </Button>
          )}
        </>
      )}
    </div>
  );
  if ('inline' in shape) return body;
  return (
    <Dialog
      title={shape.title ?? 'Choose a folder'}
      open
      onClose={shape.onClose}
      actions={
        <>
          <Button variant="ghost" onClick={shape.onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!typed} onClick={() => onPick(typed)}>
            Use this folder
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
