import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonicalPath, exists } from './files.js';

export function expandFolder(path: string) {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
export async function browseFolders(path = homedir(), offset = 0) {
  let current = resolve(expandFolder(path || homedir()));
  while (!(await exists(current))) current = dirname(current);
  current = await canonicalPath(current);
  if (!(await stat(current)).isDirectory()) throw new Error('Choose a directory');
  const folders = (await readdir(current, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(current, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    path: current,
    parent: dirname(current),
    folders: folders.slice(offset, offset + 100),
    next: offset + 100 < folders.length ? offset + 100 : null,
  };
}
export function absoluteFolder(path: string) {
  const expanded = expandFolder(path);
  if (!isAbsolute(expanded)) throw new Error('Choose an absolute folder path');
  return expanded;
}
