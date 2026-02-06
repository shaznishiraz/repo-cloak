/**
 * Interactive File Selector
 * Allows users to browse and select files/folders with search
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * Recursively get all files and folders in a directory
 */
function getFileTree(dir, basePath = dir, depth = 0, maxDepth = 10) {
    const items = [];

    if (depth > maxDepth) return items;

    try {
        const entries = readdirSync(dir, { withFileTypes: true });

        // Sort: folders first, then files, both alphabetically
        entries.sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            const relativePath = relative(basePath, fullPath);

            // Skip common ignored directories
            if (shouldIgnore(entry.name)) continue;

            if (entry.isDirectory()) {
                items.push({
                    name: entry.name,
                    path: fullPath,
                    relativePath,
                    isDirectory: true,
                    depth
                });

                // Recursively get children
                const children = getFileTree(fullPath, basePath, depth + 1, maxDepth);
                items.push(...children);
            } else {
                items.push({
                    name: entry.name,
                    path: fullPath,
                    relativePath,
                    isDirectory: false,
                    depth
                });
            }
        }
    } catch (error) {
        // Permission denied or other errors - skip this directory
    }

    return items;
}

/**
 * Check if a file/folder should be ignored
 */
function shouldIgnore(name) {
    const ignoreList = [
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
        '.repo-cloak-map.json'
    ];

    return ignoreList.includes(name) || name.startsWith('.');
}

/**
 * Format a file tree item for display
 */
function formatItem(item, selected) {
    const indent = '  '.repeat(item.depth);
    const icon = item.isDirectory ? '📁' : '📄';
    const prefix = selected ? chalk.green('✓ ') : '  ';
    const name = item.isDirectory
        ? chalk.blue.bold(item.name + sep)
        : chalk.white(item.name);

    return `${prefix}${indent}${icon} ${name}`;
}

/**
 * Interactive file selector with search and multi-select
 */
export async function selectFiles(sourceDir) {
    console.log(chalk.cyan('\n📂 Scanning directory...\n'));

    const fileTree = getFileTree(sourceDir);

    if (fileTree.length === 0) {
        console.log(chalk.yellow('No files found in this directory.'));
        return [];
    }

    console.log(chalk.dim(`Found ${fileTree.length} items\n`));

    // Create choices for inquirer
    const choices = fileTree.map(item => ({
        name: formatItem(item, false),
        value: item.path,
        short: item.relativePath,
        checked: false,
        item // Store original item for reference
    }));

    // Use inquirer checkbox with search
    const { selectedFiles } = await inquirer.prompt([
        {
            type: 'checkbox',
            name: 'selectedFiles',
            message: 'Select files and folders to extract (space to select, enter to confirm):',
            choices,
            pageSize: 20,
            loop: false,
            validate: (answer) => {
                if (answer.length === 0) {
                    return 'Please select at least one file or folder.';
                }
                return true;
            }
        }
    ]);

    // Expand selected directories to include all their contents
    const expandedSelection = new Set();

    for (const path of selectedFiles) {
        expandedSelection.add(path);

        // If it's a directory, add all children
        const item = fileTree.find(f => f.path === path);
        if (item && item.isDirectory) {
            for (const child of fileTree) {
                if (child.path.startsWith(path + sep)) {
                    expandedSelection.add(child.path);
                }
            }
        }
    }

    // Filter to only include files (for copying)
    const filesToCopy = Array.from(expandedSelection).filter(path => {
        const item = fileTree.find(f => f.path === path);
        return item && !item.isDirectory;
    });

    return filesToCopy;
}

/**
 * Search files by name pattern
 */
export async function searchFiles(sourceDir, pattern) {
    const fileTree = getFileTree(sourceDir);
    const regex = new RegExp(pattern, 'i');

    return fileTree.filter(item => regex.test(item.name));
}
