/**
 * File Copier
 * Copies files while preserving directory structure
 * Now also anonymizes folder/file names!
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative, basename } from 'path';
import { isBinaryFile } from './scanner.js';

/**
 * Apply replacements to a path (file/folder names)
 */
function anonymizePath(relativePath, replacements) {
    if (!replacements || replacements.length === 0) {
        return relativePath;
    }

    let result = relativePath;
    for (const { original, replacement } of replacements) {
        // Case-insensitive replacement
        const regex = new RegExp(escapeRegex(original), 'gi');
        result = result.replace(regex, (match) => matchCase(match, replacement));
    }
    return result;
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match case pattern
 */
function matchCase(original, replacement) {
    if (original === original.toUpperCase()) {
        return replacement.toUpperCase();
    }
    if (original === original.toLowerCase()) {
        return replacement.toLowerCase();
    }
    if (original[0] === original[0].toUpperCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    }
    return replacement;
}

/**
 * Copy a single file, creating directories as needed
 */
export function copyFile(sourcePath, destPath) {
    const destDir = dirname(destPath);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(sourcePath, destPath);
}

/**
 * Copy a file with content transformation
 */
export function copyFileWithTransform(sourcePath, destPath, transformFn) {
    const destDir = dirname(destPath);
    mkdirSync(destDir, { recursive: true });

    if (isBinaryFile(sourcePath)) {
        copyFileSync(sourcePath, destPath);
        return { transformed: false };
    }

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
        copyFileSync(sourcePath, destPath);
        return { transformed: false, error: error.message };
    }
}

/**
 * Copy multiple files with progress callback
 * Now also renames folders/files based on replacements!
 */
export async function copyFiles(files, sourceBase, destBase, transformFn, onProgress, replacements = []) {
    const results = {
        total: files.length,
        copied: 0,
        transformed: 0,
        pathsRenamed: 0,
        errors: []
    };

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const originalRelativePath = typeof file === 'string'
            ? relative(sourceBase, file)
            : file.relativePath;
        const sourcePath = typeof file === 'string' ? file : file.absolutePath;

        // Anonymize the path (folder and file names)
        const anonymizedPath = anonymizePath(originalRelativePath, replacements);
        const destPath = join(destBase, anonymizedPath);

        if (anonymizedPath !== originalRelativePath) {
            results.pathsRenamed++;
        }

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
                file: originalRelativePath,
                error: error.message
            });
        }

        if (onProgress) {
            onProgress(i + 1, files.length, anonymizedPath);
        }
    }

    return results;
}
