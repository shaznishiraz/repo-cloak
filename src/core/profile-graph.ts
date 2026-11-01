import { validateRelativePath } from './paths.js';
import { scopeName } from './profiles.js';
import type { SavedProfile } from './profiles.js';
import type { Profile } from './rules.js';

const maxDepth = 8;
const keyOf = (saved: SavedProfile) => `${scopeName(saved.scope)}:${saved.id}`;
const label = (saved: SavedProfile) => `${scopeName(saved.scope)}:${saved.profile.name}`;

function parseRef(ref: string) {
  const qualified = /^(global|repo):(.+)$/.exec(ref);
  return qualified
    ? { kind: qualified[1] as 'global' | 'repo', name: qualified[2] as string }
    : { kind: undefined, name: ref };
}
/** A profile sees global profiles, and its own repository's when it belongs to one. */
function reachable(child: SavedProfile, parent: SavedProfile) {
  if (parent.scope.kind === 'global') return true;
  return child.scope.kind === 'repo' && child.scope.repoId === parent.scope.repoId;
}
function parentOf(child: SavedProfile, ref: string, available: readonly SavedProfile[]) {
  const { kind, name } = parseRef(ref);
  const matches = available.filter(
    (saved) =>
      saved.profile.name === name &&
      reachable(child, saved) &&
      (!kind || saved.scope.kind === kind),
  );
  const first = matches[0];
  if (!first) throw new Error(`${label(child)} extends "${ref}", which was not found`);
  if (matches.length > 1)
    throw new Error(
      `${label(child)} extends "${ref}", which is ambiguous; use global:${name} or repo:${name}`,
    );
  return first;
}

/** Selected profiles plus everything they extend, parents first, each one once. */
export function expandProfiles(
  selected: readonly SavedProfile[],
  available: readonly SavedProfile[],
): SavedProfile[] {
  const picked = new Set<string>();
  for (const saved of selected) {
    if (picked.has(keyOf(saved))) throw new Error(`${label(saved)}: profile selected twice`);
    picked.add(keyOf(saved));
  }
  const done = new Set<string>();
  const order: SavedProfile[] = [];
  function visit(saved: SavedProfile, trail: SavedProfile[]) {
    const key = keyOf(saved);
    if (trail.some((item) => keyOf(item) === key))
      throw new Error(
        `Profiles extend each other: ${[...trail, saved].map((item) => item.profile.name).join(' -> ')}`,
      );
    if (done.has(key)) return;
    if (trail.length >= maxDepth)
      throw new Error(`${label(trail[0] ?? saved)}: extends goes deeper than ${maxDepth} levels`);
    for (const ref of saved.profile.extends ?? [])
      visit(parentOf(saved, ref, available), [...trail, saved]);
    done.add(key);
    order.push(saved);
  }
  for (const saved of selected) visit(saved, []);
  return order;
}

/** Whether `child` names `parent` directly: what a delete or a rename would break. */
export function extendsDirectly(child: SavedProfile, parent: SavedProfile): boolean {
  if (keyOf(child) === keyOf(parent) || !reachable(child, parent)) return false;
  return (child.profile.extends ?? []).some((ref) => {
    const { kind, name } = parseRef(ref);
    return name === parent.profile.name && (!kind || kind === parent.scope.kind);
  });
}

/** Why a root cannot be used, or undefined. A root names a folder, never a pattern. */
export function rootProblem(root: string): string | undefined {
  const folder = root.replace(/\/$/, '');
  if (/[*?[\]{}!]/.test(root)) return 'a root is a folder, not a pattern';
  if (root.includes('\\')) return 'use "/" as the folder separator';
  try {
    validateRelativePath(folder);
  } catch {
    return 'use a folder inside the repository, such as "src/"';
  }
  return undefined;
}
function withinRoots(path: string, roots: readonly string[]) {
  return roots.some((root) => {
    // A malformed root matches nothing, whatever a hand-edited document says.
    if (rootProblem(root)) return false;
    const folder = root.replace(/\/$/, '');
    return path === folder || path.startsWith(`${folder}/`);
  });
}
/**
 * Fails closed: every profile that declares roots must allow the path, an empty list allows
 * nothing, and a path that is not a clean repository-relative path is never allowed.
 */
export function isAllowedPath(path: string, profiles: readonly Profile[]): boolean {
  if (profiles.every((profile) => profile.allowRoots === undefined)) return true;
  let clean: string;
  try {
    clean = validateRelativePath(path);
  } catch {
    return false;
  }
  if (clean !== path) return false;
  return profiles.every(
    (profile) => profile.allowRoots === undefined || withinRoots(clean, profile.allowRoots),
  );
}
/** Last check before file contents are used: also covers where a symlink actually points. */
export function assertWithinRoots(
  files: readonly { path: string; realPath?: string; bytes?: Uint8Array }[],
  profiles: readonly SavedProfile[],
) {
  const documents = profiles.map((saved) => saved.profile);
  for (const file of files) {
    if (!file.bytes) continue;
    for (const path of [file.path, file.realPath ?? file.path])
      if (!isAllowedPath(path, documents))
        throw new Error(`${path} is outside the allowed roots of the selected profiles`);
  }
}
