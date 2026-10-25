import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import pLimit from 'p-limit';
import { isBinaryFileSync } from 'isbinaryfile';
import { checkSourceDestination } from './files.js';
import { isWithin } from './locations.js';
import { validateRelativePath } from '../core/paths.js';
import type { SourceFile } from '../core/pull.js';

/** A request never allocates or reads beyond its owner-configured per-file cap. */
export async function readLimitedSourceFiles(
  root: string,
  paths: string[],
  maxBytes: number,
  concurrency: number,
) {
  const limit = pLimit(concurrency);
  const canonical = await realpath(root);
  const files = await Promise.all(
    paths.map((path) =>
      limit(async (): Promise<SourceFile> => {
        validateRelativePath(path);
        await checkSourceDestination(root, path);
        const target = await realpath(join(root, path));
        if (!isWithin(canonical, target)) throw new Error('Requested file escapes source');
        const file = await open(target, 'r');
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > maxBytes)
            throw new Error('Requested file exceeds its size or type policy');
          const buffer = Buffer.alloc(info.size + 1);
          let count = 0;
          while (count < buffer.length) {
            const read = await file.read(buffer, count, buffer.length - count, count);
            if (!read.bytesRead) break;
            count += read.bytesRead;
          }
          if (count > info.size)
            throw new Error('Requested file grew while preparing the request; retry');
          const bytes = buffer.subarray(0, count);
          if (isBinaryFileSync(bytes)) throw new Error('Requests can pull text files only');
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          return { path, bytes, text, binary: false, executable: !!(info.mode & 0o111) };
        } finally {
          await file.close();
        }
      }),
    ),
  );
  return { files, warnings: [] as string[] };
}
