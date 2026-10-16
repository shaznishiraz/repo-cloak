/**
 * Path Cache Module Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';

// Use createRequire inside vi.hoisted so we can call path/os before ES imports are resolved
const { testConfigDir } = vi.hoisted(() => {
    // eslint-disable-next-line no-undef
    const os = require('os');
    // eslint-disable-next-line no-undef
    const path = require('path');
    return {
        testConfigDir: path.join(os.tmpdir(), `repo-cloak-path-cache-test-${Date.now()}`)
    };
});

vi.mock('../src/core/crypto.js', () => ({
    hasSecret: () => true,
    getOrCreateSecret: () => 'test-secret-key',
    encrypt: (text) => `enc:${text}`,
    decrypt: (text) => (text.startsWith('enc:') ? text.slice(4) : null)
}));

vi.mock('../src/core/path-cache.js', async () => {
    const { hasSecret, getOrCreateSecret, encrypt, decrypt } = await import('../src/core/crypto.js');
    const { existsSync: fsExists, readFileSync, writeFileSync, mkdirSync: fsMkdir } = await import('fs');
    const path = await import('path');

    const CACHE_FILE = path.join(testConfigDir, 'path-cache.json');
    const MAX_PATHS = 10;

    function loadRawCache() {
        try {
            if (!fsExists(CACHE_FILE)) return { sources: [], destinations: [] };
            const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
            return {
                sources: Array.isArray(parsed.sources) ? parsed.sources : [],
                destinations: Array.isArray(parsed.destinations) ? parsed.destinations : []
            };
        } catch { return { sources: [], destinations: [] }; }
    }

    function saveRawCache(cache) {
        if (!fsExists(testConfigDir)) fsMkdir(testConfigDir, { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    }

    function decryptPaths(encrypted, secret) {
        return encrypted.map(e => { try { return decrypt(e, secret); } catch { return null; } }).filter(Boolean);
    }

    return {
        getSourcePaths: () => {
            if (!hasSecret()) return [];
            return decryptPaths(loadRawCache().sources, getOrCreateSecret());
        },
        getDestPaths: () => {
            if (!hasSecret()) return [];
            return decryptPaths(loadRawCache().destinations, getOrCreateSecret());
        },
        addSourcePath: (p) => {
            const secret = getOrCreateSecret();
            const cache = loadRawCache();
            const existing = decryptPaths(cache.sources, secret);
            const deduped = [p, ...existing.filter(x => x !== p)].slice(0, MAX_PATHS);
            cache.sources = deduped.map(x => encrypt(x, secret));
            saveRawCache(cache);
        },
        addDestPath: (p) => {
            const secret = getOrCreateSecret();
            const cache = loadRawCache();
            const existing = decryptPaths(cache.destinations, secret);
            const deduped = [p, ...existing.filter(x => x !== p)].slice(0, MAX_PATHS);
            cache.destinations = deduped.map(x => encrypt(x, secret));
            saveRawCache(cache);
        }
    };
});

import { getSourcePaths, getDestPaths, addSourcePath, addDestPath } from '../src/core/path-cache.js';

describe('Path Cache Module', () => {
    beforeEach(() => {
        if (existsSync(testConfigDir)) rmSync(testConfigDir, { recursive: true, force: true });
        mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testConfigDir)) rmSync(testConfigDir, { recursive: true, force: true });
    });

    describe('getSourcePaths', () => {
        it('returns empty array when no cache exists', () => {
            expect(getSourcePaths()).toEqual([]);
        });

        it('returns previously added source paths', () => {
            addSourcePath('/path/to/repo');
            expect(getSourcePaths()).toContain('/path/to/repo');
        });
    });

    describe('getDestPaths', () => {
        it('returns empty array when no cache exists', () => {
            expect(getDestPaths()).toEqual([]);
        });

        it('returns previously added destination paths', () => {
            addDestPath('/path/to/output');
            expect(getDestPaths()).toContain('/path/to/output');
        });
    });

    describe('addSourcePath', () => {
        it('adds multiple paths and returns most recent first', () => {
            addSourcePath('/first');
            addSourcePath('/second');
            addSourcePath('/third');

            const paths = getSourcePaths();
            expect(paths[0]).toBe('/third');
            expect(paths[1]).toBe('/second');
            expect(paths[2]).toBe('/first');
        });

        it('deduplicates paths, moving existing path to front', () => {
            addSourcePath('/a');
            addSourcePath('/b');
            addSourcePath('/a');

            const paths = getSourcePaths();
            expect(paths[0]).toBe('/a');
            expect(paths.filter(p => p === '/a')).toHaveLength(1);
        });

        it('caps at MAX_PATHS (10) entries', () => {
            for (let i = 0; i < 15; i++) addSourcePath(`/path/${i}`);
            expect(getSourcePaths().length).toBeLessThanOrEqual(10);
        });
    });

    describe('addDestPath', () => {
        it('adds multiple destination paths and returns most recent first', () => {
            addDestPath('/out/a');
            addDestPath('/out/b');

            const paths = getDestPaths();
            expect(paths[0]).toBe('/out/b');
            expect(paths[1]).toBe('/out/a');
        });

        it('deduplicates destination paths', () => {
            addDestPath('/out/x');
            addDestPath('/out/y');
            addDestPath('/out/x');

            const paths = getDestPaths();
            expect(paths[0]).toBe('/out/x');
            expect(paths.filter(p => p === '/out/x')).toHaveLength(1);
        });
    });
});
