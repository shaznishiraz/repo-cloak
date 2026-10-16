/**
 * Crypto Module
 * Handles encryption/decryption of sensitive data using user-specific secret
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.repo-cloak');
const SECRET_FILE = join(CONFIG_DIR, 'secret.key');
const ALGORITHM = 'aes-256-gcm';

/**
 * Get or create user's secret key
 */
export function getOrCreateSecret() {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Check if secret exists
    if (existsSync(SECRET_FILE)) {
        return readFileSync(SECRET_FILE, 'utf-8').trim();
    }

    // Generate new secret
    const secret = randomBytes(32).toString('hex');
    writeFileSync(SECRET_FILE, secret, { mode: 0o600 }); // Read/write only for owner

    return secret;
}

/**
 * Check if user has a secret key
 */
export function hasSecret() {
    return existsSync(SECRET_FILE);
}

/**
 * Encrypt a string using user's secret
 */
export function encrypt(text, secret) {
    const key = scryptSync(secret, 'repo-cloak-salt', 32);
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    // Return iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a string using user's secret
 */
export function decrypt(encryptedData, secret) {
    try {
        const [ivHex, authTagHex, encrypted] = encryptedData.split(':');

        if (!ivHex || !authTagHex || !encrypted) {
            throw new Error('Invalid encrypted data format');
        }

        const key = scryptSync(secret, 'repo-cloak-salt', 32);
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = createDecipheriv(ALGORITHM, key, iv);

        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (error) {
        return null; // Decryption failed
    }
}

/**
 * Encrypt replacements for storage
 */
export function encryptReplacements(replacements, secret) {
    return replacements.map(r => ({
        original: encrypt(r.original, secret),
        replacement: r.replacement, // Keep replacement visible (it's the safe version)
        encrypted: true
    }));
}

/**
 * Decrypt replacements from storage
 */
export function decryptReplacements(replacements, secret) {
    return replacements.map(r => {
        if (!r.encrypted) {
            return r; // Already decrypted or legacy format
        }

        const original = decrypt(r.original, secret);

        if (original === null) {
            return {
                ...r,
                original: null, // Failed to decrypt
                decryptFailed: true
            };
        }

        return {
            original,
            replacement: r.replacement
        };
    });
}

/**
 * Get the config directory path
 */
export function getConfigDir() {
    return CONFIG_DIR;
}
