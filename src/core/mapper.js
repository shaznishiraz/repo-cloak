/**
 * Mapping File Manager
 * Tracks replacements and file mappings for push/pull operations
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const MAP_FILENAME = '.repo-cloak-map.json';

/**
 * Create a mapping object
 */
export function createMapping(options) {
    const {
        sourceDir,
        destDir,
        replacements,
        files,
        timestamp = new Date().toISOString()
    } = options;

    return {
        version: '1.0.0',
        tool: 'repo-cloak',
        timestamp,
        source: {
            path: sourceDir,
            platform: process.platform
        },
        destination: {
            path: destDir
        },
        replacements: replacements.map(r => ({
            original: r.original,
            replacement: r.replacement
        })),
        files: files.map(f => ({
            original: typeof f === 'string' ? f : f.relativePath,
            cloaked: typeof f === 'string' ? f : f.relativePath
        })),
        stats: {
            totalFiles: files.length,
            replacementsCount: replacements.length
        }
    };
}

/**
 * Save mapping to destination directory
 */
export function saveMapping(destDir, mapping) {
    const mapPath = join(destDir, MAP_FILENAME);
    writeFileSync(mapPath, JSON.stringify(mapping, null, 2), 'utf-8');
    return mapPath;
}

/**
 * Load mapping from a cloaked directory
 */
export function loadMapping(cloakedDir) {
    const mapPath = join(cloakedDir, MAP_FILENAME);

    if (!existsSync(mapPath)) {
        throw new Error(`No mapping file found in ${cloakedDir}. Is this a repo-cloak backup?`);
    }

    try {
        const content = readFileSync(mapPath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        throw new Error(`Failed to read mapping file: ${error.message}`);
    }
}

/**
 * Check if a directory has a mapping file
 */
export function hasMapping(dir) {
    const mapPath = join(dir, MAP_FILENAME);
    return existsSync(mapPath);
}

/**
 * Get the original source path from mapping
 */
export function getOriginalSource(mapping) {
    return mapping.source?.path || null;
}

/**
 * Get replacements from mapping
 */
export function getReplacements(mapping) {
    return mapping.replacements || [];
}

/**
 * Get file list from mapping
 */
export function getFiles(mapping) {
    return mapping.files || [];
}

/**
 * Update mapping with additional info
 */
export function updateMapping(destDir, updates) {
    const mapPath = join(destDir, MAP_FILENAME);

    if (!existsSync(mapPath)) {
        throw new Error('No mapping file found');
    }

    const mapping = loadMapping(destDir);
    const updated = { ...mapping, ...updates, updatedAt: new Date().toISOString() };

    writeFileSync(mapPath, JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
}
