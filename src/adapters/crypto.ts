import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open as openFile, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sealedSchema } from '../core/schemas.js';
import type { Sealed } from '../core/schemas.js';
import { errorCode } from './atomic.js';

function validateKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('Encryption key must contain exactly 32 bytes');
  return key;
}
export function keyId(key: Buffer): string {
  return `k_${createHash('sha256').update(validateKey(key)).digest('hex').slice(0, 12)}`;
}
export async function loadKey(path: string): Promise<Buffer> {
  const key = validateKey(await readFile(path));
  return key;
}
export async function getOrCreateKey(path: string): Promise<Buffer> {
  try {
    const key = await loadKey(path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
    return key;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.key-${randomUUID()}.tmp`);
  try {
    const handle = await openFile(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
    // An exclusive hard link publishes the complete key without replacing a race winner.
    try {
      await link(temporary, path);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    return await loadKey(path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }
}

// JSON with sorted object keys makes AAD insensitive to formatting/key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function aad(plain: unknown): Buffer {
  return Buffer.from(canonical(JSON.parse(JSON.stringify(plain))));
}
export function seal(value: unknown, key: Buffer, plain: unknown = {}): Sealed {
  validateKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(plain));
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Only JSON data can be sealed');
  const data = Buffer.concat([cipher.update(json, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    alg: 'A256GCM',
    keyId: keyId(key),
    nonce: nonce.toString('base64'),
    data: data.toString('base64'),
  };
}
export function open(blob: unknown, key: Buffer, plain: unknown = {}): unknown {
  const sealed = sealedSchema.parse(blob);
  if (sealed.keyId !== keyId(key))
    throw new Error(
      `Cannot open sealed data: requires keyId ${sealed.keyId}, available ${keyId(key)}`,
    );
  try {
    const nonce = Buffer.from(sealed.nonce, 'base64');
    const data = Buffer.from(sealed.data, 'base64');
    if (
      nonce.length !== 12 ||
      data.length < 16 ||
      nonce.toString('base64') !== sealed.nonce ||
      data.toString('base64') !== sealed.data
    )
      throw new Error('Invalid sealed data encoding or length');
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(plain));
    cipher.setAuthTag(data.subarray(-16));
    return JSON.parse(
      Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString('utf8'),
    ) as unknown;
  } catch (cause) {
    throw new Error(
      `Cannot authenticate sealed data for keyId ${sealed.keyId}: data or plain metadata was altered`,
      { cause },
    );
  }
}
