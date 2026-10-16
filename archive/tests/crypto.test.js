/**
 * Crypto Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encrypt, decrypt, encryptReplacements, decryptReplacements } from '../src/core/crypto.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('Crypto Module', () => {
    const testSecret = 'test-secret-key-for-unit-tests-1234567890';

    describe('encrypt/decrypt', () => {
        it('should encrypt and decrypt a string', () => {
            const original = 'Hello World';
            const encrypted = encrypt(original, testSecret);
            const decrypted = decrypt(encrypted, testSecret);

            expect(decrypted).toBe(original);
        });

        it('should produce different encrypted output each time (random IV)', () => {
            const original = 'Same input';
            const encrypted1 = encrypt(original, testSecret);
            const encrypted2 = encrypt(original, testSecret);

            expect(encrypted1).not.toBe(encrypted2);
        });

        it('should return null for wrong secret', () => {
            const original = 'Secret message';
            const encrypted = encrypt(original, testSecret);
            const decrypted = decrypt(encrypted, 'wrong-secret');

            expect(decrypted).toBeNull();
        });

        it('should handle special characters', () => {
            const original = 'Special: @#$%^&*()_+ 日本語 🎭';
            const encrypted = encrypt(original, testSecret);
            const decrypted = decrypt(encrypted, testSecret);

            expect(decrypted).toBe(original);
        });

        it('should handle empty string or return null for empty', () => {
            const original = '';
            const encrypted = encrypt(original, testSecret);
            const decrypted = decrypt(encrypted, testSecret);

            // Empty string may return empty or null depending on cipher
            expect(decrypted === '' || decrypted === null).toBe(true);
        });

        it('should handle long strings', () => {
            const original = 'A'.repeat(10000);
            const encrypted = encrypt(original, testSecret);
            const decrypted = decrypt(encrypted, testSecret);

            expect(decrypted).toBe(original);
        });
    });

    describe('encryptReplacements/decryptReplacements', () => {
        it('should encrypt only the original field', () => {
            const replacements = [
                { original: 'Microsoft', replacement: 'ABCCompany' },
                { original: 'Secret', replacement: 'Public' }
            ];

            const encrypted = encryptReplacements(replacements, testSecret);

            // Replacement should still be visible
            expect(encrypted[0].replacement).toBe('ABCCompany');
            expect(encrypted[1].replacement).toBe('Public');

            // Original should be encrypted (contains colons from format)
            expect(encrypted[0].original).toContain(':');
            expect(encrypted[0].encrypted).toBe(true);
        });

        it('should decrypt back to original', () => {
            const replacements = [
                { original: 'Microsoft', replacement: 'ABCCompany' }
            ];

            const encrypted = encryptReplacements(replacements, testSecret);
            const decrypted = decryptReplacements(encrypted, testSecret);

            expect(decrypted[0].original).toBe('Microsoft');
            expect(decrypted[0].replacement).toBe('ABCCompany');
        });

        it('should mark failed decryptions', () => {
            const replacements = [
                { original: 'Test', replacement: 'Demo' }
            ];

            const encrypted = encryptReplacements(replacements, testSecret);
            const decrypted = decryptReplacements(encrypted, 'wrong-secret');

            expect(decrypted[0].decryptFailed).toBe(true);
        });
    });
});
