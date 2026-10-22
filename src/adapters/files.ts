import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { glob } from 'glob';
import { isBinaryFileSync } from 'isbinaryfile';
import pLimit from 'p-limit';
import { validateRelativePath } from '../core/paths.js';
import { compilePatterns } from '../core/patterns.js';
import type { SourceFile } from '../core/pull.js';
import type { Profile } from '../core/rules.js';
import { errorCode } from './atomic.js';
import { isWithin } from './locations.js';

const metadata = ['**/.git', '**/.git/**', '**/.repo-cloak', '**/.repo-cloak/**'];
const excluded = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/vendor/**',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock*',
  '**/*.snap',
];
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}
export async function expandPaths(
  root: string,
  cwd: string,
  paths: string[],
  profiles: Profile[] = [],
): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    const absolute = isAbsolute(path) ? path : resolve(cwd, path);
    if (!isWithin(root, absolute))
      throw new Error(`Selection is outside the source repository: ${path}`);
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      if (absolute !== root && (await exists(join(absolute, '.git')))) continue;
      // Prune what can never be selected; filterPaths makes the final, authoritative decision.
      const ignored = compilePatterns([
        ...metadata,
        ...(profiles.some((profile) => profile.include?.length) ? [] : excluded),
        ...profiles.flatMap((profile) => profile.exclude ?? []),
      ]);
      const base = relative(root, absolute);
      const fromRoot = (path: string) => join(base, path).replaceAll('\\', '/');
      const files = await glob('**/*', {
        cwd: absolute,
        dot: true,
        nodir: true,
        follow: false,
        posix: true,
        ignore: {
          ignored: (path) => ignored(fromRoot(path.relative())),
          childrenIgnored: (path) =>
            path.fullpath() !== root &&
            (ignored(fromRoot(path.relative())) || existsSync(join(path.fullpath(), '.git'))),
        },
      });
      result.push(
        ...files.map((file) => relative(root, join(absolute, file)).replaceAll('\\', '/')),
      );
    } else result.push(relative(root, absolute).replaceAll('\\', '/'));
  }
  return result;
}
/**
 * Final selection filter for repository-relative paths. Metadata is never copied; a profile
 * exclude always wins; profile includes bring back files skipped by the default exclusions.
 */
export function filterPaths(paths: string[], profiles: Profile[]): string[] {
  const isMetadata = compilePatterns(metadata);
  const isDefault = compilePatterns(excluded);
  const isExcluded = compilePatterns(profiles.flatMap((profile) => profile.exclude ?? []));
  const isIncluded = compilePatterns(profiles.flatMap((profile) => profile.include ?? []));
  return paths.filter(
    (path) => !isMetadata(path) && !isExcluded(path) && (!isDefault(path) || isIncluded(path)),
  );
}
async function nestedRepo(root: string, path: string): Promise<boolean> {
  const parts = relative(root, path).split(/[\\/]/).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (await exists(join(current, '.git'))) return true;
  }
  return false;
}
export async function readSourceFiles(root: string, paths: string[], concurrency: number) {
  root = await realpath(root);
  const limit = pLimit(concurrency);
  const warnings: string[] = [];
  const result = await Promise.all(
    paths.map((path) =>
      limit(async (): Promise<SourceFile | undefined> => {
        path = validateRelativePath(path);
        const file = join(root, ...path.split('/'));
        const missing: SourceFile = { path, binary: false, executable: false };
        try {
          const target = await realpath(file);
          if (!isWithin(root, target)) {
            warnings.push(`${path}: skipped external symlink`);
            return undefined;
          }
          if ((await nestedRepo(root, file)) || (await nestedRepo(root, target))) {
            warnings.push(`${path}: skipped submodule or nested repository`);
            return undefined;
          }
          const info = await stat(target);
          if (!info.isFile()) {
            warnings.push(`${path}: skipped non-file`);
            return undefined;
          }
          const bytes = await readFile(target);
          const source: SourceFile = {
            path,
            bytes,
            binary: isBinaryFileSync(bytes),
            executable: Boolean(info.mode & 0o111),
          };
          if (!source.binary) {
            try {
              source.text = decoder.decode(bytes);
            } catch {
              source.binary = true;
            }
          }
          return source;
        } catch (error) {
          if (errorCode(error) === 'ENOENT') return missing;
          throw error;
        }
      }),
    ),
  );
  return {
    files: result.filter((file): file is SourceFile => file !== undefined),
    warnings: warnings.sort(),
  };
}
export async function readWorkspace(root: string, paths: string[], concurrency: number) {
  if (!(await exists(root))) return { files: {}, paths: [] as string[] };
  const names = await glob('**/*', {
    cwd: root,
    dot: true,
    nodir: true,
    follow: false,
    ignore: metadata,
    posix: true,
  });
  const limit = pLimit(concurrency);
  const pairs = await Promise.all(
    [...new Set(paths)].map((path) =>
      limit(async () => {
        validateRelativePath(path);
        const file = join(root, ...path.split('/'));
        try {
          await checkDestinationPath(root, path);
          const info = await lstat(file);
          if (!info.isFile()) throw new Error(`${path}: workspace path is not a regular file`);
          return [path, await readFile(file)] as const;
        } catch (error) {
          if (errorCode(error) === 'ENOENT') return undefined;
          throw error;
        }
      }),
    ),
  );
  return { files: Object.fromEntries(pairs.filter((pair) => pair !== undefined)), paths: names };
}
export async function checkDestinationPath(root: string, path: string): Promise<void> {
  const parts = path.split('/');
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(`${path}: refusing a symlink in the workspace destination`);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
  }
}

/** A restore must never write into a nested repository or through a symlink. */
export async function checkSourceDestination(root: string, path: string): Promise<void> {
  await checkDestinationPath(root, path);
  let current = root;
  for (const part of validateRelativePath(path).split('/').slice(0, -1)) {
    current = join(current, part);
    if (await exists(join(current, '.git')))
      throw new Error(`${path}: refusing to write into a nested repository`);
  }
}

export { canonicalPath, isWithin } from './locations.js';
export async function listDirectory(path: string): Promise<string[]> {
  return readdir(path);
}
