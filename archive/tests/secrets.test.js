/**
 * Secrets Detection Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanFileForSecrets, scanFilesForSecrets } from '../src/core/secrets.js';
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Secrets Module', () => {
    let testDir;

    beforeEach(() => {
        testDir = join(tmpdir(), `repo-cloak-secrets-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testDir)) {
            try {
                rmSync(testDir, { recursive: true, force: true });
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    });

    describe('scanFileForSecrets', () => {
        it('should detect AWS Access Keys', () => {
            const filePath = join(testDir, 'aws.env');
            writeFileSync(filePath, 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n');
            
            const findings = scanFileForSecrets(filePath);
            expect(findings).toHaveLength(1);
            expect(findings[0].type).toBe('AWS Access Key ID');
            expect(findings[0].line).toBe(1);
        });

        it('should detect generic API keys', () => {
            const filePath = join(testDir, 'config.js');
            writeFileSync(filePath, `
                const config = {
                    api_key: "abc123DEF456ghi789jkl012mno",
                    port: 8080
                };
            `);
            
            const findings = scanFileForSecrets(filePath);
            expect(findings.length).toBeGreaterThan(0);
            expect(findings[0].type).toBe('Generic API Key / Token');
        });

        it('should not detect harmless text', () => {
            const filePath = join(testDir, 'readme.md');
            writeFileSync(filePath, 'This is a normal file without secrets.\nAPI keys are good.\n');
            
            const findings = scanFileForSecrets(filePath);
            expect(findings).toHaveLength(0);
        });

        it('should detect multiple secrets in one file', () => {
            const filePath = join(testDir, 'keys.txt');
            writeFileSync(filePath, 'AKIAIOSFODNN7EXAMPLE\nghp_123456789012345678901234567890123456\n');
            
            const findings = scanFileForSecrets(filePath);
            expect(findings).toHaveLength(2);
            expect(findings.find(f => f.type === 'AWS Access Key ID')).toBeDefined();
            expect(findings.find(f => f.type === 'GitHub Token')).toBeDefined();
        });

        it('should ignore binary files', () => {
            const filePath = join(testDir, 'image.png');
            writeFileSync(filePath, 'AKIAIOSFODNN7EXAMPLE'); // Test content but .png extension
            
            const findings = scanFileForSecrets(filePath);
            expect(findings).toHaveLength(0);
        });
    });

    describe('scanFilesForSecrets', async () => {
        it('should aggregate findings from multiple files', async () => {
            const file1 = join(testDir, 'f1.txt');
            writeFileSync(file1, 'AKIAIOSFODNN7EXAMPLE');

            const file2 = join(testDir, 'f2.txt');
            writeFileSync(file2, 'ghp_123456789012345678901234567890123456');

            const findings = await scanFilesForSecrets([file1, file2]);
            expect(findings).toHaveLength(2);
        });
    });
});
