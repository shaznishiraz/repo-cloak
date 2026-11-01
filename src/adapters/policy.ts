import { createPublicKey, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { join } from 'node:path';
import { policySchema } from '../core/policy.js';
import type { LoadedPolicy } from '../core/policy.js';
import { errorCode } from './atomic.js';

export const policyFile = 'policy.json';
export const signatureFile = 'policy.json.sig';
export const publicKeyFile = 'policy.pub';
const maxBytes = 1024 * 1024;

export function policyDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'darwin') return '/Library/Application Support/repo-cloak';
  if (platform === 'win32') return win32.join(env.ProgramData ?? 'C:\\ProgramData', 'repo-cloak');
  return '/etc/repo-cloak';
}

async function optional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}
async function writable(path: string) {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the machine-wide policy. If `policy.pub` is present the policy must carry a valid
 * Ed25519 signature; a signature with no key to check it against is also rejected. Unreadable
 * or unverifiable policies come back as `invalid`, never as "no policy".
 */
export async function loadPolicy(directory = policyDirectory()): Promise<LoadedPolicy> {
  const path = join(directory, policyFile);
  const invalid = (message: string): LoadedPolicy => ({ status: 'invalid', path, message });
  try {
    const bytes = await optional(path);
    if (!bytes) return { status: 'none' };
    if (bytes.length > maxBytes) return invalid('The policy file is too large');
    const [signature, publicKey] = await Promise.all([
      optional(join(directory, signatureFile)),
      optional(join(directory, publicKeyFile)),
    ]);
    if (signature && !publicKey) return invalid('The policy is signed but policy.pub is missing');
    if (publicKey && !signature) return invalid('policy.pub requires a signed policy');
    if (publicKey && signature) {
      const key = createPublicKey(publicKey);
      if (key.asymmetricKeyType !== 'ed25519') return invalid('policy.pub is not an Ed25519 key');
      const decoded = Buffer.from(signature.toString('utf8').trim(), 'base64');
      if (!verify(null, bytes, key, decoded)) return invalid('The policy signature does not match');
    }
    const parsed = policySchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success) return invalid('The policy does not match the policy schema');
    return {
      status: 'active',
      policy: parsed.data,
      path,
      signed: !!signature,
      userWritable: await writable(path),
    };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'The policy cannot be read');
  }
}
