/**
 * Interactive File Selector
 * Hierarchical tree view with pagination
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { readdirSync } from 'fs';
import { join, relative, sep } from 'path';

// Directories to always ignore
const IGNORE_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', '.DS_Store', 'Thumbs.db',
    '.idea', '.vscode', '__pycache__', '.pytest_cache', 'dist', 'build',
    '.next', '.nuxt', 'coverage', '.nyc_output', '.repo-cloak-map.json',
    'obj', 'bin', 'packages', '.vs', 'TestResults'
]);

const PAGE_SIZE = 50;

function shouldIgnore(name) {
    return IGNORE_DIRS.has(name) || name.startsWith('.');
}

function buildFileIndex(baseDir, maxDepth = 8) {
    const files = [];

    function scan(dir, depth = 0) {
        if (depth > maxDepth) return;

        try {
            const entries = readdirSync(dir, { withFileTypes: true });

            entries.sort((a, b) => {
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            });

            for (const entry of entries) {
                if (shouldIgnore(entry.name)) continue;

                const fullPath = join(dir, entry.name);
                const relativePath = relative(baseDir, fullPath);

                files.push({
                    name: entry.name,
                    path: fullPath,
                    relativePath,
                    isDirectory: entry.isDirectory(),
                    depth
                });

                if (entry.isDirectory()) {
                    scan(fullPath, depth + 1);
                }
            }
        } catch (error) { }
    }

    scan(baseDir);
    return files;
}

function getFilesInDirectory(dir) {
    const files = [];

    function collect(currentDir) {
        try {
            const entries = readdirSync(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                if (shouldIgnore(entry.name)) continue;
                const fullPath = join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    collect(fullPath);
                } else {
                    files.push(fullPath);
                }
            }
        } catch (error) { }
    }

    collect(dir);
    return files;
}

function formatTreeItem(item) {
    const indent = '  '.repeat(item.depth);
    const icon = item.isDirectory ? '📁' : '📄';
    const name = item.isDirectory
        ? chalk.blue.bold(item.name)
        : chalk.white(item.name);
    return `${indent}${icon} ${name}`;
}

/**
 * Show paginated results with Load More option
 */
async function showPaginatedResults(filtered, selectedPaths, page = 0) {
    const start = page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, filtered.length);
    const pageItems = filtered.slice(start, end);
    const hasMore = end < filtered.length;
    const remaining = filtered.length - end;

    // Build choices
    const choices = pageItems.map(f => {
        let isChecked = false;
        if (f.isDirectory) {
            const childFiles = getFilesInDirectory(f.path);
            isChecked = childFiles.length > 0 && childFiles.every(fp => selectedPaths.has(fp));
        } else {
            isChecked = selectedPaths.has(f.path);
        }

        return {
            name: formatTreeItem(f),
            value: f,
            checked: isChecked,
            short: f.relativePath
        };
    });

    // Add separator and load more option if there are more results
    if (hasMore) {
        choices.push(new inquirer.Separator(chalk.dim('─────────────────────────────')));
        choices.push({
            name: chalk.cyan(`⏬ Load next ${Math.min(PAGE_SIZE, remaining)} items (${remaining} remaining)`),
            value: '__LOAD_MORE__',
            short: 'Load more'
        });
    }

    const pageInfo = `Page ${page + 1} (${start + 1}-${end} of ${filtered.length})`;

    const { picked } = await inquirer.prompt([
        {
            type: 'checkbox',
            name: 'picked',
            message: `${pageInfo}:`,
            choices,
            pageSize: 25,
            loop: false
        }
    ]);

    return { picked, pageItems, hasMore };
}

export async function selectFiles(sourceDir) {
    console.log(chalk.cyan('\n📂 Scanning directory...'));

    const fileIndex = buildFileIndex(sourceDir);
    console.log(chalk.dim(`   Found ${fileIndex.length} items\n`));

    if (fileIndex.length === 0) {
        console.log(chalk.yellow('   No files found.'));
        return [];
    }

    const selectedPaths = new Set();
    let continueLoop = true;

    console.log(chalk.cyan('🔍 File Selection'));
    console.log(chalk.dim('   • Type to filter → Space to tick → Enter to confirm'));
    console.log(chalk.dim('   • Select "Load more" to see next batch'));
    console.log(chalk.dim('   • Empty search = done\n'));

    while (continueLoop) {
        if (selectedPaths.size > 0) {
            console.log(chalk.green(`\n   📦 ${selectedPaths.size} file(s) selected`));
        }

        const { searchTerm } = await inquirer.prompt([
            {
                type: 'input',
                name: 'searchTerm',
                message: 'Filter (empty = done):',
                prefix: '🔎'
            }
        ]);

        if (!searchTerm.trim()) {
            if (selectedPaths.size === 0) {
                const { confirmExit } = await inquirer.prompt([
                    { type: 'confirm', name: 'confirmExit', message: 'No files selected. Exit?', default: false }
                ]);
                if (confirmExit) continueLoop = false;
            } else {
                continueLoop = false;
            }
            continue;
        }

        // Filter by search term
        const query = searchTerm.toLowerCase();
        const filtered = fileIndex.filter(f =>
            f.relativePath.toLowerCase().includes(query) ||
            f.name.toLowerCase().includes(query)
        );

        if (filtered.length === 0) {
            console.log(chalk.yellow('   No matches found.'));
            continue;
        }

        console.log(chalk.dim(`   Found ${filtered.length} matches`));

        // Pagination loop
        let page = 0;
        let continuePaging = true;

        while (continuePaging) {
            const { picked, pageItems, hasMore } = await showPaginatedResults(filtered, selectedPaths, page);

            // Check if user selected "Load More"
            const loadMore = picked.find(p => p === '__LOAD_MORE__');
            const actualPicks = picked.filter(p => p !== '__LOAD_MORE__');

            // Process deselections for this page
            const pickedPaths = new Set(actualPicks.map(p => p.path));
            for (const f of pageItems) {
                if (!pickedPaths.has(f.path)) {
                    if (f.isDirectory) {
                        const childFiles = getFilesInDirectory(f.path);
                        childFiles.forEach(fp => selectedPaths.delete(fp));
                    } else {
                        selectedPaths.delete(f.path);
                    }
                }
            }

            // Process selections
            for (const f of actualPicks) {
                if (f.isDirectory) {
                    const childFiles = getFilesInDirectory(f.path);
                    childFiles.forEach(fp => selectedPaths.add(fp));
                    console.log(chalk.green(`   + 📁 ${f.relativePath}/ (${childFiles.length} files)`));
                } else {
                    selectedPaths.add(f.path);
                    console.log(chalk.green(`   + 📄 ${f.relativePath}`));
                }
            }

            // Handle load more or exit pagination
            if (loadMore && hasMore) {
                page++;
            } else {
                continuePaging = false;
            }
        }
    }

    console.log(chalk.green(`\n✓ Total: ${selectedPaths.size} files selected\n`));
    return Array.from(selectedPaths);
}
