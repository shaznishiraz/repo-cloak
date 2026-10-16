/**
 * Directory Scanner
 * Scans and builds file tree structure
 */

import { readdirSync, statSync } from 'fs';
import { join, relative, sep, extname } from 'path';

// Binary file extensions to copy without modification
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    '.sqlite', '.db', '.mdb'
]);

// Directories to always ignore
const IGNORE_DIRS = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '.DS_Store',
    'Thumbs.db',
    '.idea',
    '.vscode',
    '__pycache__',
    '.pytest_cache',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '.nyc_output',
    '.repo-cloak-map.json',
    '.env',
    '.env.local'
]);

/**
 * Check if a file is binary based on extension
 */
export function isBinaryFile(filePath) {
    const ext = extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}

/**
 * Check if a file/folder should be ignored
 */
export function shouldIgnore(name) {
    return IGNORE_DIRS.has(name) || name.startsWith('.');
}

/**
 * Recursively get all files in a directory
 */
export function getAllFiles(dir, basePath = dir, files = []) {
    try {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);

            if (shouldIgnore(entry.name)) continue;

            if (entry.isDirectory()) {
                getAllFiles(fullPath, basePath, files);
            } else {
                files.push({
                    absolutePath: fullPath,
                    relativePath: relative(basePath, fullPath),
                    name: entry.name,
                    isBinary: isBinaryFile(fullPath)
                });
            }
        }
    } catch (error) {
        // Permission denied or other errors - skip
    }

    return files;
}

/**
 * Get directory structure for display
 */
export function getDirectoryTree(dir, basePath = dir, depth = 0, maxDepth = 5) {
    const tree = [];

    if (depth > maxDepth) return tree;

    try {
        const entries = readdirSync(dir, { withFileTypes: true });

        // Sort: folders first, then files
        entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            if (shouldIgnore(entry.name)) continue;

            const fullPath = join(dir, entry.name);
            const node = {
                name: entry.name,
                path: fullPath,
                relativePath: relative(basePath, fullPath),
                isDirectory: entry.isDirectory(),
                depth
            };

            tree.push(node);

            if (entry.isDirectory()) {
                const children = getDirectoryTree(fullPath, basePath, depth + 1, maxDepth);
                tree.push(...children);
            }
        }
    } catch (error) {
        // Skip inaccessible directories
    }

    return tree;
}

/**
 * Count files in a directory (recursive)
 */
export function countFiles(dir) {
    return getAllFiles(dir).length;
}
