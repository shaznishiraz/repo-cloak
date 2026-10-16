/**
 * Mapper Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    createMapping,
    saveMapping,
    loadRawMapping,
    mergeMapping,
    hasMapping
} from '../src/core/mapper.js';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Mapper Module', () => {
    let testDir;

    beforeEach(() => {
        testDir = join(tmpdir(), `repo-cloak-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    describe('createMapping', () => {
        it('should create a valid mapping object', () => {
            const mapping = createMapping({
                sourceDir: '/path/to/source',
                destDir: '/path/to/dest',
                replacements: [{ original: 'Test', replacement: 'Demo' }],
                files: [{ original: 'file.js', cloaked: 'file.js' }]
            });

            expect(mapping.version).toBe('1.1.0');
            expect(mapping.tool).toBe('repo-cloak');
            expect(mapping.encrypted).toBe(true);
            expect(mapping.files).toHaveLength(1);
            expect(mapping.stats.totalFiles).toBe(1);
        });

        it('should encrypt sensitive data', () => {
            const mapping = createMapping({
                sourceDir: '/secret/path',
                destDir: '/dest/path',
                replacements: [{ original: 'SecretWord', replacement: 'Public' }],
                files: [{ original: 'secret.js', cloaked: 'public.js' }]
            });

            // Source path should be encrypted (contains :)
            expect(mapping.source.path).toContain(':');
            // Replacements original should be encrypted
            expect(mapping.replacements[0].original).toContain(':');
            expect(mapping.replacements[0].encrypted).toBe(true);
        });
    });

    describe('saveMapping / loadRawMapping', () => {
        it('should save and load mapping file', () => {
            const mapping = {
                version: '1.0.0',
                files: [{ original: 'a.js', cloaked: 'b.js' }]
            };

            saveMapping(testDir, mapping);

            expect(hasMapping(testDir)).toBe(true);

            const loaded = loadRawMapping(testDir);
            expect(loaded.version).toBe('1.0.0');
            expect(loaded.files).toHaveLength(1);
        });

        it('should return null for non-existent mapping', () => {
            const loaded = loadRawMapping('/non/existent/path');
            expect(loaded).toBeNull();
        });
    });

    describe('hasMapping', () => {
        it('should return true when mapping exists', () => {
            writeFileSync(join(testDir, '.repo-cloak-map.json'), '{}');
            expect(hasMapping(testDir)).toBe(true);
        });

        it('should return false when mapping does not exist', () => {
            expect(hasMapping(testDir)).toBe(false);
        });
    });

    describe('mergeMapping', () => {
        it('should merge new files with existing mapping', () => {
            const existing = {
                version: '1.0.0',
                files: [
                    { original: 'a.js', cloaked: 'a.js' },
                    { original: 'b.js', cloaked: 'b.js' }
                ],
                stats: { totalFiles: 2 }
            };

            const newFiles = [
                { original: 'c.js', cloaked: 'c.js' },
                { original: 'd.js', cloaked: 'd.js' }
            ];

            const merged = mergeMapping(existing, newFiles);

            expect(merged.files).toHaveLength(4);
            expect(merged.stats.totalFiles).toBe(4);
        });

        it('should avoid duplicate files', () => {
            const existing = {
                version: '1.0.0',
                files: [
                    { original: 'a.js', cloaked: 'a.js' },
                    { original: 'b.js', cloaked: 'b.js' }
                ],
                stats: { totalFiles: 2 }
            };

            const newFiles = [
                { original: 'b.js', cloaked: 'b.js' },  // Duplicate
                { original: 'c.js', cloaked: 'c.js' }   // New
            ];

            const merged = mergeMapping(existing, newFiles);

            expect(merged.files).toHaveLength(3); // Not 4
            expect(merged.stats.totalFiles).toBe(3);
        });

        it('should track pull history', () => {
            const existing = {
                version: '1.0.0',
                files: [],
                stats: { totalFiles: 0 }
            };

            const merged = mergeMapping(existing, [{ original: 'a.js', cloaked: 'a.js' }]);

            expect(merged.pullHistory).toHaveLength(1);
            expect(merged.pullHistory[0].filesAdded).toBe(1);
            expect(merged.pullHistory[0].timestamp).toBeDefined();
        });

        it('should append to existing pull history', () => {
            const existing = {
                version: '1.0.0',
                files: [{ original: 'a.js', cloaked: 'a.js' }],
                stats: { totalFiles: 1 },
                pullHistory: [{ timestamp: '2024-01-01', filesAdded: 1, totalFiles: 1 }]
            };

            const merged = mergeMapping(existing, [{ original: 'b.js', cloaked: 'b.js' }]);

            expect(merged.pullHistory).toHaveLength(2);
        });
    });
});
