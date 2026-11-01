import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { errorCode, writeAtomic } from './atomic.js';

/** Runs a program without a shell. Secrets travel on stdin, never in arguments. */
export type KeychainExec = (
  file: string,
  args: string[],
  stdin?: string,
) => Promise<{ stdout: string }>;
export type Keychain = {
  label: string;
  available(): Promise<boolean>;
  get(account: string): Promise<Buffer | undefined>;
  set(account: string, key: Buffer): Promise<void>;
  remove(account: string): Promise<void>;
};

const service = 'repo-cloak';

const runProgram: KeychainExec = (file, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr }));
        else resolve({ stdout });
      },
    );
    // A missing program fails the callback above; the stream error must not crash the process.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin ?? '');
  });

function exitCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}
function stderrOf(error: unknown): string {
  return error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
}
function checkAccount(account: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(account)) throw new Error('Invalid keychain account');
}
function decodeKey(text: string): Buffer | undefined {
  const value = text.trim();
  return /^[a-f0-9]{64}$/.test(value) ? Buffer.from(value, 'hex') : undefined;
}

function macKeychain(exec: KeychainExec): Keychain {
  return {
    label: 'macOS Keychain',
    async available() {
      try {
        await exec('security', ['default-keychain']);
        return true;
      } catch {
        return false;
      }
    },
    async get(account) {
      checkAccount(account);
      try {
        const args = ['find-generic-password', '-a', account, '-s', service, '-w'];
        const value = decodeKey((await exec('security', args)).stdout);
        if (!value) throw new Error('The keychain item is not a repo-cloak key');
        return value;
      } catch (error) {
        if (exitCode(error) === 44) return undefined; // errSecItemNotFound
        throw error;
      }
    },
    async set(account, key) {
      checkAccount(account);
      // `security -i` reads the command from stdin, which keeps the key out of `ps`. It also
      // exits 0 when a command fails, so the write only counts once it reads back.
      const command = `add-generic-password -U -a ${account} -s ${service} -w ${key.toString('hex')}\n`;
      await exec('security', ['-i'], command);
      const stored = await this.get(account);
      if (!stored?.equals(key)) throw new Error('The keychain did not store the key');
    },
    async remove(account) {
      checkAccount(account);
      try {
        await exec('security', ['delete-generic-password', '-a', account, '-s', service]);
      } catch (error) {
        if (exitCode(error) !== 44) throw error;
      }
    },
  };
}

function linuxKeychain(exec: KeychainExec): Keychain {
  const attributes = (account: string) => ['service', service, 'account', account];
  async function lookup(account: string) {
    try {
      return (await exec('secret-tool', ['lookup', ...attributes(account)])).stdout;
    } catch (error) {
      // Not found exits 1 silently; a missing secret service also exits 1 but explains why.
      if (exitCode(error) === 1 && !stderrOf(error)) return undefined;
      throw error;
    }
  }
  return {
    label: 'Secret Service',
    async available() {
      try {
        await lookup('availability-probe');
        return true;
      } catch {
        return false;
      }
    },
    async get(account) {
      checkAccount(account);
      const text = await lookup(account);
      if (text === undefined) return undefined;
      const value = decodeKey(text);
      if (!value) throw new Error('The secret service item is not a repo-cloak key');
      return value;
    },
    async set(account, key) {
      checkAccount(account);
      const args = ['store', '--label=repo-cloak store key', ...attributes(account)];
      await exec('secret-tool', args, key.toString('hex'));
    },
    async remove(account) {
      checkAccount(account);
      await exec('secret-tool', ['clear', ...attributes(account)]);
    },
  };
}

const powershellPrelude =
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());";
const dpapiScope = '[System.Security.Cryptography.DataProtectionScope]::CurrentUser';
const protectScript = `${powershellPrelude}[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($in,$null,${dpapiScope}))`;
const unprotectScript = `${powershellPrelude}[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,${dpapiScope}))`;

/** DPAPI encrypts for the current Windows user; the encrypted blob lives in the store. */
function windowsKeychain(exec: KeychainExec, root: string): Keychain {
  const powershell = (script: string, stdin: string) =>
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], stdin);
  const blob = (account: string) => join(root, `key.${account}.dpapi`);
  return {
    label: 'Windows DPAPI',
    async available() {
      try {
        const probe = Buffer.from('probe').toString('base64');
        const sealed = (await powershell(protectScript, probe)).stdout.trim();
        return (await powershell(unprotectScript, sealed)).stdout.trim() === probe;
      } catch {
        return false;
      }
    },
    async get(account) {
      checkAccount(account);
      let sealed: string;
      try {
        sealed = await readFile(blob(account), 'utf8');
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
      const value = Buffer.from(
        (await powershell(unprotectScript, sealed)).stdout.trim(),
        'base64',
      );
      if (value.length !== 32) throw new Error('The DPAPI blob is not a repo-cloak key');
      return value;
    },
    async set(account, key) {
      checkAccount(account);
      const sealed = await powershell(protectScript, key.toString('base64'));
      await writeAtomic(blob(account), sealed.stdout.trim());
    },
    async remove(account) {
      checkAccount(account);
      await unlink(blob(account)).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    },
  };
}

export function createKeychain(
  root: string,
  platform: NodeJS.Platform = process.platform,
  exec: KeychainExec = runProgram,
): Keychain | undefined {
  if (platform === 'darwin') return macKeychain(exec);
  if (platform === 'linux') return linuxKeychain(exec);
  if (platform === 'win32') return windowsKeychain(exec, root);
  return undefined;
}
