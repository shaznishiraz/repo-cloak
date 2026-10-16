/**
 * Path Cache Module
 * Stores recently used source and destination paths, encrypted with the user's secret key.
 * Persisted to ~/.repo-cloak/path-cache.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { encrypt, decrypt, getOrCreateSecret, hasSecret } from './crypto.js';

const CONFIG_DIR = join(homedir(), '.repo-cloak');
const CACHE_FILE = join(CONFIG_DIR, 'path-cache.json');
const MAX_PATHS = 10;

/**
 * Load the raw cache file (entries are stored encrypted)
 * @returns {{ sources: string[], destinations: string[] }}
 */
function loadRawCache() {
    try {
        if (!existsSync(CACHE_FILE)) {
            return { sources: [], destinations: [] };
        }
        const raw = readFileSync(CACHE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            sources: Array.isArray(parsed.sources) ? parsed.sources : [],
            destinations: Array.isArray(parsed.destinations) ? parsed.destinations : []
        };
    } catch {
        return { sources: [], destinations: [] };
    }
}

/**
 * Save entries back to the cache file
 * @param {{ sources: string[], destinations: string[] }} cache
 */
function saveRawCache(cache) {
    try {
        if (!existsSync(CONFIG_DIR)) {
            mkdirSync(CONFIG_DIR, { recursive: true });
        }
        writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch {
        // Silently ignore write errors – caching is best-effort
    }
}

/**
 * Decrypt a list of encrypted path strings. Returns only successfully decrypted values.
 * @param {string[]} encrypted
 * @param {string} secret
 * @returns {string[]}
 */
function decryptPaths(encrypted, secret) {
    return encrypted
        .map(e => {
            try {
                return decrypt(e, secret);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get recently used source paths (decrypted). Returns empty array if no secret exists yet.
 * @returns {string[]}
 */
export function getSourcePaths() {
    if (!hasSecret()) return [];
    const secret = getOrCreateSecret();
    const cache = loadRawCache();
    return decryptPaths(cache.sources, secret);
}

/**
 * Get recently used destination paths (decrypted). Returns empty array if no secret exists yet.
 * @returns {string[]}
 */
export function getDestPaths() {
    if (!hasSecret()) return [];
    const secret = getOrCreateSecret();
    const cache = loadRawCache();
    return decryptPaths(cache.destinations, secret);
}

/**
 * Persist a source path to the cache (encrypted). Moves it to the front and deduplicates.
 * @param {string} path - Absolute path
 */
export function addSourcePath(path) {
    try {
        const secret = getOrCreateSecret();
        const cache = loadRawCache();

        // Decrypt existing to deduplicate
        const existing = decryptPaths(cache.sources, secret);
        const deduped = [path, ...existing.filter(p => p !== path)].slice(0, MAX_PATHS);

        cache.sources = deduped.map(p => encrypt(p, secret));
        saveRawCache(cache);
    } catch {
        // Silently ignore
    }
}

/**
 * Persist a destination path to the cache (encrypted). Moves it to the front and deduplicates.
 * @param {string} path - Absolute path
 */
export function addDestPath(path) {
    try {
        const secret = getOrCreateSecret();
        const cache = loadRawCache();

        // Decrypt existing to deduplicate
        const existing = decryptPaths(cache.destinations, secret);
        const deduped = [path, ...existing.filter(p => p !== path)].slice(0, MAX_PATHS);

        cache.destinations = deduped.map(p => encrypt(p, secret));
        saveRawCache(cache);
    } catch {
        // Silently ignore
    }
}
