import { useEffect, useState } from 'preact/hooks';
import type { FolderListing } from '../../api/contracts.js';
import { api } from '../../shell/load.js';
import { Button, Dialog, Field } from '../../shell/ui/index.js';
import { parentFolder } from './model.js';

/** Browses local folders through the server. Also usable by Settings and Known repos. */
export function FolderPicker({
  initial,
  title = 'Choose a folder',
  onPick,
  onClose,
}: {
  initial?: string | undefined;
  title?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState(initial ?? '');
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(path: string | undefined, offset = 0) {
    setError(null);
    try {
      const next = await api().call('GET /api/v2/folders', {
        query: {
          ...(path ? { path } : {}),
          ...(offset ? { offset: String(offset) } : {}),
        },
      });
      setTyped(next.path);
      setListing((current) =>
        offset && current ? { ...next, folders: [...current.folders, ...next.folders] } : next,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read that folder');
    }
  }
  useEffect(() => {
    void load(initial);
  }, []);

  return (
    <Dialog
      title={title}
      open
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!typed} onClick={() => onPick(typed)}>
            Use this folder
          </Button>
        </>
      }
    >
      <div class="picker">
        <Field
          label="Folder path"
          value={typed}
          error={error ?? undefined}
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
          <Button
            size="small"
            disabled={!listing}
            onClick={() => listing && void load(parentFolder(listing.path))}
          >
            Parent folder
          </Button>
        </div>
        <div class="picker-list" role="group" aria-label="Folders">
          {listing?.folders.map((folder) => (
            <button
              type="button"
              class="picker-row"
              key={folder.path}
              onClick={() => void load(folder.path)}
            >
              {folder.name}/
            </button>
          ))}
          {listing && !listing.folders.length && <p class="muted">No folders here.</p>}
          {listing?.next !== null && listing?.next !== undefined && (
            <Button size="small" onClick={() => void load(listing.path, listing.next ?? 0)}>
              More folders
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
