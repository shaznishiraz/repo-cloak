import { useEffect, useRef, useState } from 'preact/hooks';
import type { TreeNode } from '../../api/contracts.js';
import { pickState, togglePick } from './model.js';

const visibleRows = 300;

function nodeName(path: string) {
  return path.split('/').at(-1) ?? path;
}

function PickBox({
  node,
  state,
  onToggle,
}: {
  node: TreeNode;
  state: string;
  onToggle: () => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = state === 'partial';
  }, [state]);
  return (
    <input
      ref={box}
      type="checkbox"
      checked={state === 'on'}
      aria-label={`Pick ${node.path}`}
      onChange={onToggle}
    />
  );
}

/** Files and folders from `git ls-files`, loaded one level at a time. Excluded nodes stay locked. */
export function FileTree({
  load,
  paths,
  heldBack,
  onChange,
  onNodes,
}: {
  load: (directory?: string) => Promise<TreeNode[]>;
  paths: ReadonlySet<string>;
  heldBack: ReadonlyMap<string, string>;
  onChange: (paths: Set<string>) => void;
  onNodes: (nodes: TreeNode[]) => void;
}) {
  const [levels, setLevels] = useState<Record<string, TreeNode[]>>({});
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [more, setMore] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function fetchLevel(directory: string) {
    try {
      const nodes = await load(directory || undefined);
      setLevels((current) => ({ ...current, [directory]: nodes }));
      onNodes(nodes);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not list files');
    }
  }
  useEffect(() => {
    setLevels({});
    setOpen(new Set());
    void fetchLevel('');
  }, [load]);

  function toggleOpen(path: string) {
    const next = new Set(open);
    if (next.delete(path)) {
      setOpen(next);
      return;
    }
    next.add(path);
    setOpen(next);
    if (!levels[path]) void fetchLevel(path);
  }

  function rows(directory: string, depth: number) {
    const nodes = levels[directory];
    if (!nodes) return depth ? <div class="tree-note">Loading…</div> : null;
    const shown = more.has(directory) ? nodes : nodes.slice(0, visibleRows);
    return (
      <>
        {shown.map((node) => {
          const rule = node.excludedBy ?? heldBack.get(node.path) ?? null;
          const folder = node.kind === 'folder';
          const expanded = open.has(node.path);
          const name = `${nodeName(node.path)}${folder ? '/' : ''}`;
          return (
            <div key={node.path}>
              <div
                class={`tree-row${rule ? ' tree-row-excluded' : ''}`}
                style={{ paddingLeft: `${depth * 14}px` }}
              >
                {rule ? (
                  <span class="tree-lock" aria-hidden="true">
                    ×
                  </span>
                ) : (
                  <PickBox
                    node={node}
                    state={pickState(node.path, paths)}
                    onToggle={() => onChange(togglePick(paths, node, (path) => levels[path]))}
                  />
                )}
                {folder && !rule ? (
                  <button
                    type="button"
                    class="tree-name tree-folder"
                    aria-expanded={expanded}
                    onClick={() => toggleOpen(node.path)}
                  >
                    <span aria-hidden="true">{expanded ? '▾ ' : '▸ '}</span>
                    {name}
                  </button>
                ) : (
                  <span class="tree-name">{name}</span>
                )}
                {rule ? (
                  <span class="tree-rule">excluded · {rule}</span>
                ) : (
                  folder && (
                    <span class="tree-note">
                      {node.files} {node.files === 1 ? 'file' : 'files'}
                    </span>
                  )
                )}
              </div>
              {folder && expanded && !rule && rows(node.path, depth + 1)}
            </div>
          );
        })}
        {shown.length < nodes.length && (
          <button
            type="button"
            class="link-button"
            style={{ marginLeft: `${depth * 14}px` }}
            onClick={() => setMore(new Set([...more, directory]))}
          >
            Show {nodes.length - shown.length} more
          </button>
        )}
      </>
    );
  }

  return (
    <div class="tree" aria-label="Files and folders" role="group">
      {error && <div class="tree-rule">{error}</div>}
      {rows('', 0)}
    </div>
  );
}
