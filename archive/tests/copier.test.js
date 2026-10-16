/**
 * Copier Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFile, copyFileWithTransform } from '../src/core/copier.js';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Copier Module', () => {
    let testDir;
    let sourceDir;
    let destDir;

    beforeEach(() => {
        testDir = join(tmpdir(), `repo-cloak-copier-test-${Date.now()}`);
        sourceDir = join(testDir, 'source');
        destDir = join(testDir, 'dest');
        mkdirSync(sourceDir, { recursive: true });
        mkdirSync(destDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    describe('copyFile', () => {
        it('should copy a file to destination', () => {
            const sourceFile = join(sourceDir, 'test.txt');
            const destFile = join(destDir, 'test.txt');

            writeFileSync(sourceFile, 'Hello World');
            copyFile(sourceFile, destFile);

            expect(existsSync(destFile)).toBe(true);
            expect(readFileSync(destFile, 'utf-8')).toBe('Hello World');
        });

        it('should create nested directories', () => {
            const sourceFile = join(sourceDir, 'test.txt');
            const destFile = join(destDir, 'nested', 'deep', 'test.txt');

            writeFileSync(sourceFile, 'Content');
            copyFile(sourceFile, destFile);

            expect(existsSync(destFile)).toBe(true);
        });
    });

    describe('copyFileWithTransform', () => {
        it('should transform content during copy', () => {
            const sourceFile = join(sourceDir, 'code.js');
            const destFile = join(destDir, 'code.js');

            writeFileSync(sourceFile, 'const company = "Microsoft";');

            const transform = (content) => content.replace(/Microsoft/g, 'ABCCompany');
            const result = copyFileWithTransform(sourceFile, destFile, transform);

            expect(result.transformed).toBe(true);
            expect(readFileSync(destFile, 'utf-8')).toBe('const company = "ABCCompany";');
        });

        it('should report no transformation when content unchanged', () => {
            const sourceFile = join(sourceDir, 'code.js');
            const destFile = join(destDir, 'code.js');

            writeFileSync(sourceFile, 'const x = 1;');

            const transform = (content) => content.replace(/Microsoft/g, 'ABCCompany');
            const result = copyFileWithTransform(sourceFile, destFile, transform);

            expect(result.transformed).toBe(false);
        });

        it('should handle binary files by copying as-is', () => {
            const sourceFile = join(sourceDir, 'image.png');
            const destFile = join(destDir, 'image.png');

            // Create a simple binary-like file
            const buffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00]);
            writeFileSync(sourceFile, buffer);

            const transform = (content) => content.replace(/test/g, 'replaced');
            const result = copyFileWithTransform(sourceFile, destFile, transform);

            expect(result.transformed).toBe(false);
            expect(existsSync(destFile)).toBe(true);
        });
    });
});
