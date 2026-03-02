/**
 * Git Integration
 * Utilities to interact with Git repositories
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

const execAsync = promisify(exec);

/**
 * Check if a directory is a Git repository
 * @param {string} dirPath - Directory to check
 * @returns {boolean} True if .git folder exists
 */
export function isGitRepo(dirPath) {
    return existsSync(join(dirPath, '.git'));
}

/**
 * Get list of changed/added/untracked files
 * @param {string} dirPath - Repository root
 * @returns {Promise<string[]>} List of relative file paths
 */
export async function getChangedFiles(dirPath) {
    try {
        // -u option shows individual files in untracked directories
        const { stdout } = await execAsync('git status --porcelain -u', { cwd: dirPath });

        if (!stdout) return [];

        const files = stdout
            .split('\n')
            .filter(line => line.trim() !== '')
            .map(line => {
                // Format: "MM file.txt" or "?? file.txt" or "R  old -> new"
                const status = line.substring(0, 2);
                let file = line.substring(3).trim();

                // Handle renamed files: "old -> new"
                if (file.includes(' -> ')) {
                    file = file.split(' -> ')[1];
                }

                // Remove quotes if present (git status quotes files with spaces)
                const cleanFile = file.replace(/^"|"$/g, '');

                return { status, file: cleanFile };
            })
            // Filter deleted files (D) as we can't pull them
            .filter(item => !item.status.includes('D'))
            .map(item => item.file);

        return files;
    } catch (error) {
        // If git command fails, return empty list
        return [];
    }
}
