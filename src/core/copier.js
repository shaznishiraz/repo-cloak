/**
 * File Copier
 * Copies files while preserving directory structure
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { isBinaryFile } from './scanner.js';

/**
 * Copy a single file, creating directories as needed
 */
export function copyFile(sourcePath, destPath) {
    // Ensure destination directory exists
    const destDir = dirname(destPath);
    mkdirSync(destDir, { recursive: true });

    // Copy the file
    copyFileSync(sourcePath, destPath);
}

/**
 * Copy a file with content transformation
 */
export function copyFileWithTransform(sourcePath, destPath, transformFn) {
    // Ensure destination directory exists
    const destDir = dirname(destPath);
    mkdirSync(destDir, { recursive: true });

    // Check if binary - copy as-is
    if (isBinaryFile(sourcePath)) {
        copyFileSync(sourcePath, destPath);
        return { transformed: false };
    }

    // Read, transform, write
    try {
        let content = readFileSync(sourcePath, 'utf-8');
        const originalContent = content;
        content = transformFn(content);
        writeFileSync(destPath, content, 'utf-8');
        return {
            transformed: content !== originalContent,
            originalLength: originalContent.length,
            newLength: content.length
        };
    } catch (error) {
        // If reading as text fails, copy as binary
        copyFileSync(sourcePath, destPath);
        return { transformed: false, error: error.message };
    }
}

/**
 * Copy multiple files with progress callback
 */
export async function copyFiles(files, sourceBase, destBase, transformFn, onProgress) {
    const results = {
        total: files.length,
        copied: 0,
        transformed: 0,
        errors: []
    };

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const relativePath = typeof file === 'string'
            ? relative(sourceBase, file)
            : file.relativePath;
        const sourcePath = typeof file === 'string' ? file : file.absolutePath;
        const destPath = join(destBase, relativePath);

        try {
            if (transformFn) {
                const result = copyFileWithTransform(sourcePath, destPath, transformFn);
                if (result.transformed) {
                    results.transformed++;
                }
            } else {
                copyFile(sourcePath, destPath);
            }
            results.copied++;
        } catch (error) {
            results.errors.push({
                file: relativePath,
                error: error.message
            });
        }

        if (onProgress) {
            onProgress(i + 1, files.length, relativePath);
        }
    }

    return results;
}
