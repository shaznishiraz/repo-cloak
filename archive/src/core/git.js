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

/**
 * Get recent commits
 * @param {string} dirPath - Repository root
 * @param {number} count - Number of commits to retrieve
 * @returns {Promise<Array<{hash: string, message: string}>>} List of commit objects
 */
export async function getRecentCommits(dirPath, count = 10) {
    try {
        const { stdout } = await execAsync(`git log -n ${count} --pretty=format:"%h - %s"`, { cwd: dirPath });
        if (!stdout) return [];

        return stdout
            .split(/\r?\n/)
            .filter(line => line.trim() !== '')
            .map(line => {
                const sepIndex = line.indexOf(' - ');
                if (sepIndex === -1) return { hash: line.trim(), message: '' };
                const hash = line.substring(0, sepIndex).trim();
                const message = line.substring(sepIndex + 3).trim();
                return { hash, message };
            });
    } catch (error) {
        return [];
    }
}

/**
 * Get list of files changed in specific commits
 * @param {string} dirPath - Repository root
 * @param {string[]} commits - List of commit hashes
 * @returns {Promise<string[]>} List of relative file paths
 */
export async function getFilesChangedInCommits(dirPath, commits) {
    if (!commits || commits.length === 0) return [];

    try {
        const filesSet = new Set();

        for (const commit of commits) {
            // --name-status outputs lines like "status\tfilePath" (e.g., "M\tfile.txt")
            const { stdout } = await execAsync(`git show --name-status --pretty="" ${commit}`, { cwd: dirPath });
            if (stdout) {
                const lines = stdout.split(/\r?\n/).filter(line => line.trim() !== '');
                for (const line of lines) {
                    const parts = line.split('\t');
                    if (parts.length < 2) continue;

                    const status = parts[0];
                    // Skip deleted files since we cannot pull them
                    if (!status.startsWith('D')) {
                        // For renamed files (Rxxx or Cxxx), parts[2] might be the new file name
                        let file = parts.length > 2 ? parts[2] : parts[1];

                        // Remove quotes if present (git status/show quotes files with spaces)
                        const cleanFile = file.replace(/^"|"$/g, '');

                        filesSet.add(cleanFile);
                    }
                }
            }
        }

        return Array.from(filesSet);
    } catch (error) {
        return [];
    }
}
