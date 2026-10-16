/**
 * Scanner Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAllFiles, isBinaryFile } from '../src/core/scanner.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Scanner Module', () => {
    let testDir;

    beforeEach(() => {
        testDir = join(tmpdir(), `repo-cloak-scanner-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    describe('getAllFiles', () => {
        it('should find all files in directory', () => {
            writeFileSync(join(testDir, 'a.js'), 'content');
            writeFileSync(join(testDir, 'b.js'), 'content');

            const files = getAllFiles(testDir);

            expect(files).toHaveLength(2);
        });

        it('should find files in nested directories', () => {
            const nestedDir = join(testDir, 'src', 'components');
            mkdirSync(nestedDir, { recursive: true });

            writeFileSync(join(testDir, 'index.js'), 'content');
            writeFileSync(join(nestedDir, 'Button.js'), 'content');

            const files = getAllFiles(testDir);

            expect(files).toHaveLength(2);
        });

        it('should ignore node_modules', () => {
            const nodeModules = join(testDir, 'node_modules', 'package');
            mkdirSync(nodeModules, { recursive: true });

            writeFileSync(join(testDir, 'index.js'), 'content');
            writeFileSync(join(nodeModules, 'index.js'), 'content');

            const files = getAllFiles(testDir);

            expect(files).toHaveLength(1);
        });

        it('should ignore .git directories', () => {
            const gitDir = join(testDir, '.git', 'objects');
            mkdirSync(gitDir, { recursive: true });

            writeFileSync(join(testDir, 'index.js'), 'content');
            writeFileSync(join(gitDir, 'abc123'), 'content');

            const files = getAllFiles(testDir);

            expect(files).toHaveLength(1);
        });

        it('should return empty array for empty directory', () => {
            const files = getAllFiles(testDir);
            expect(files).toHaveLength(0);
        });
    });

    describe('isBinaryFile', () => {
        it('should detect common binary extensions', () => {
            expect(isBinaryFile('image.png')).toBe(true);
            expect(isBinaryFile('image.jpg')).toBe(true);
            expect(isBinaryFile('archive.zip')).toBe(true);
            expect(isBinaryFile('doc.pdf')).toBe(true);
            expect(isBinaryFile('lib.dll')).toBe(true);
            expect(isBinaryFile('app.exe')).toBe(true);
        });

        it('should detect text files', () => {
            expect(isBinaryFile('code.js')).toBe(false);
            expect(isBinaryFile('style.css')).toBe(false);
            expect(isBinaryFile('data.json')).toBe(false);
            expect(isBinaryFile('README.md')).toBe(false);
            expect(isBinaryFile('code.ts')).toBe(false);
        });

        it('should handle paths with directories', () => {
            expect(isBinaryFile('/path/to/image.png')).toBe(true);
            expect(isBinaryFile('src/components/Button.js')).toBe(false);
        });
    });
});
