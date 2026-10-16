import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { errorCode } from './atomic.js';

export function isWithin(root: string, path: string): boolean {
  const name = relative(root, path);
  return !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`);
}
export async function canonicalPath(path: string): Promise<string> {
  path = resolve(path);
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw new Error(`Path root does not exist: ${path}`, { cause: error });
    return join(await canonicalPath(parent), basename(path));
  }
}
