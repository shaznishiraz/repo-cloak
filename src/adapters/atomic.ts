import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

/** Keep the old file in place until a complete, flushed replacement is ready. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.cloak-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, path);
        break;
      } catch (error) {
        // Windows antivirus/indexers can briefly hold an otherwise replaceable file.
        if (
          process.platform !== 'win32' ||
          attempt >= 5 ||
          !['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '')
        )
          throw error;
        await setTimeout(20 * (attempt + 1));
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }
}
