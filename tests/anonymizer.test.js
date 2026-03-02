/**
 * Anonymizer Tests
 */

import { describe, it, expect } from 'vitest';
import { createAnonymizer, createDeanonymizer } from '../src/core/anonymizer.js';

describe('Anonymizer', () => {
    describe('createAnonymizer', () => {
        it('should replace exact matches', () => {
            const anonymizer = createAnonymizer([
                { original: 'Microsoft', replacement: 'ABCCompany' }
            ]);

            // Title case input -> Title case output (first letter upper, rest lower)
            expect(anonymizer('Hello Microsoft world')).toBe('Hello Abccompany world');
        });

        it('should handle all uppercase', () => {
            const anonymizer = createAnonymizer([
                { original: 'Microsoft', replacement: 'ABCCompany' }
            ]);

            expect(anonymizer('Microsoft is great')).toBe('ABCCOMPANY is great');
        });

        it('should handle all lowercase', () => {
            const anonymizer = createAnonymizer([
                { original: 'Microsoft', replacement: 'ABCCompany' }
            ]);

            expect(anonymizer('Microsoft is lower')).toBe('abccompany is lower');
        });

        it('should handle multiple replacements', () => {
            const anonymizer = createAnonymizer([
                { original: 'Microsoft', replacement: 'ABCCompany' },
                { original: 'Frontend', replacement: 'Client' }
            ]);

            // Both are Title case -> first upper + rest lower
            expect(anonymizer('Microsoft Frontend API')).toBe('Abccompany Client API');
        });

        it('should handle empty replacements', () => {
            const anonymizer = createAnonymizer([]);
            expect(anonymizer('Hello world')).toBe('Hello world');
        });

        it('should handle special regex characters in original', () => {
            const anonymizer = createAnonymizer([
                { original: 'test.value', replacement: 'replaced' }
            ]);

            // Title case preservation
            expect(anonymizer('This is Test.value here')).toBe('This is Replaced here');
        });

        it('should handle null or undefined replacements', () => {
            const anonymizer = createAnonymizer(null);
            expect(anonymizer('Hello world')).toBe('Hello world');
        });
    });

    describe('createDeanonymizer', () => {
        it('should reverse the anonymization', () => {
            const replacements = [
                { original: 'Microsoft', replacement: 'ABCCompany' }
            ];

            const deanonymizer = createDeanonymizer(replacements);

            // ABCCompany (Title case) -> Microsoft (Title case: first upper + rest lower)
            expect(deanonymizer('Hello ABCCompany world')).toBe('Hello Microsoft world');
        });

        it('should handle multiple replacements in reverse', () => {
            const replacements = [
                { original: 'Microsoft', replacement: 'ABCCompany' },
                { original: 'API', replacement: 'Service' }
            ];

            const deanonymizer = createDeanonymizer(replacements);

            // Title case -> Title case for both
            expect(deanonymizer('ABCCompany Service')).toBe('Microsoft Api');
        });

        it('should handle uppercase in reverse', () => {
            const replacements = [
                { original: 'Microsoft', replacement: 'ABCCompany' }
            ];

            const deanonymizer = createDeanonymizer(replacements);

            expect(deanonymizer('ABCCOMPANY')).toBe('Microsoft');
        });

        it('should handle lowercase in reverse', () => {
            const replacements = [
                { original: 'Microsoft', replacement: 'ABCCompany' }
            ];

            const deanonymizer = createDeanonymizer(replacements);

            expect(deanonymizer('abccompany')).toBe('Microsoft');
        });
    });
});

describe('Case transformation', () => {
    it('should preserve all uppercase', () => {
        const anonymizer = createAnonymizer([
            { original: 'SECRET', replacement: 'PUBLIC' }
        ]);

        expect(anonymizer('This is SECRET data')).toBe('This is PUBLIC data');
    });

    it('should preserve all lowercase', () => {
        const anonymizer = createAnonymizer([
            { original: 'secret', replacement: 'public' }
        ]);

        expect(anonymizer('this is secret data')).toBe('this is public data');
    });
});
