/**
 * Mapping File Manager
 * Tracks replacements and file mappings for push/pull operations
 * Now with encrypted sensitive data!
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getOrCreateSecret, encryptReplacements, decryptReplacements, encrypt, decrypt } from './crypto.js';

const MAP_FILENAME = '.repo-cloak-map.json';

/**
 * Create a mapping object with encrypted sensitive data
 */
export function createMapping(options) {
    const {
        sourceDir,
        destDir,
        replacements,
        files,
        timestamp = new Date().toISOString()
    } = options;

    // Get user's secret for encryption
    const secret = getOrCreateSecret();

    // Encrypt sensitive paths
    const encryptedSource = encrypt(sourceDir, secret);
    const encryptedDest = encrypt(destDir, secret);

    // Encrypt replacements (only the "original" field)
    const encryptedReplacements = encryptReplacements(replacements, secret);

    // Encrypt original file paths
    const encryptedFiles = files.map(f => ({
        original: encrypt(f.original, secret),
        cloaked: f.cloaked // Keep cloaked version visible (it's anonymized)
    }));

    return {
        version: '1.1.0', // Updated version for encryption
        tool: 'repo-cloak',
        timestamp,
        encrypted: true, // Flag indicating encryption is used
        source: {
            path: encryptedSource,
            platform: process.platform
        },
        destination: {
            path: encryptedDest
        },
        replacements: encryptedReplacements,
        files: encryptedFiles,
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
 * Load and decrypt mapping from a cloaked directory
 */
export function loadMapping(cloakedDir, secret = null) {
    const mapPath = join(cloakedDir, MAP_FILENAME);

    if (!existsSync(mapPath)) {
        throw new Error(`No mapping file found in ${cloakedDir}. Is this a repo-cloak backup?`);
    }

    try {
        const content = readFileSync(mapPath, 'utf-8');
        const mapping = JSON.parse(content);

        // If encrypted, attempt decryption
        if (mapping.encrypted && secret) {
            return decryptMapping(mapping, secret);
        }

        return mapping;
    } catch (error) {
        throw new Error(`Failed to read mapping file: ${error.message}`);
    }
}

/**
 * Decrypt a mapping object
 */
export function decryptMapping(mapping, secret) {
    if (!mapping.encrypted) {
        return mapping;
    }

    try {
        const decryptedSource = decrypt(mapping.source?.path, secret);
        const decryptedDest = decrypt(mapping.destination?.path, secret);
        const decryptedReplacements = decryptReplacements(mapping.replacements || [], secret);

        const decryptedFiles = (mapping.files || []).map(f => ({
            original: decrypt(f.original, secret),
            cloaked: f.cloaked
        }));

        return {
            ...mapping,
            source: {
                ...mapping.source,
                path: decryptedSource,
                decrypted: true
            },
            destination: {
                ...mapping.destination,
                path: decryptedDest,
                decrypted: true
            },
            replacements: decryptedReplacements,
            files: decryptedFiles
        };
    } catch (error) {
        throw new Error(`Failed to decrypt mapping: ${error.message}`);
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
 * Get the original source path from mapping (requires secret)
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

    const content = readFileSync(mapPath, 'utf-8');
    const mapping = JSON.parse(content);
    const updated = { ...mapping, ...updates, updatedAt: new Date().toISOString() };

    writeFileSync(mapPath, JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
}

/**
 * Load existing raw mapping (without decryption) for merging
 */
export function loadRawMapping(cloakedDir) {
    const mapPath = join(cloakedDir, MAP_FILENAME);

    if (!existsSync(mapPath)) {
        return null;
    }

    try {
        const content = readFileSync(mapPath, 'utf-8');
        return JSON.parse(content);
    } catch (error) {
        return null;
    }
}

/**
 * Merge new files into existing mapping (for incremental pulls)
 */
export function mergeMapping(existingMapping, newFiles) {
    // Get existing file paths for deduplication
    const existingPaths = new Set(
        (existingMapping.files || []).map(f => f.cloaked)
    );

    // Filter out files that already exist (avoid duplicates)
    const uniqueNewFiles = newFiles.filter(f => !existingPaths.has(f.cloaked));

    // Merge files
    const mergedFiles = [
        ...(existingMapping.files || []),
        ...uniqueNewFiles
    ];

    // Track pull history
    const pullHistory = existingMapping.pullHistory || [];
    pullHistory.push({
        timestamp: new Date().toISOString(),
        filesAdded: uniqueNewFiles.length,
        totalFiles: mergedFiles.length
    });

    return {
        ...existingMapping,
        files: mergedFiles,
        pullHistory,
        stats: {
            ...existingMapping.stats,
            totalFiles: mergedFiles.length
        },
        updatedAt: new Date().toISOString()
    };
}
