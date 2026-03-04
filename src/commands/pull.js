/**
 * Pull Command
 * Extract files and anonymize sensitive information
 * Supports quick-add mode when pulling to existing cloaked directory
 */

import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, relative, join } from 'path';

import { selectFiles } from '../ui/fileSelector.js';
import {
    promptSourceDirectory,
    promptDestinationDirectory,
    promptKeywordReplacements,
    showSummaryAndConfirm,
    confirmAction
} from '../ui/prompts.js';
import { showSuccess, showError, showInfo } from '../ui/banner.js';
import { getAllFiles } from '../core/scanner.js';
import { scanFilesForSecrets } from '../core/secrets.js';
import { getAgentsMarkdown } from '../core/agents-template.js';

import { copyFiles } from '../core/copier.js';
import { createAnonymizer } from '../core/anonymizer.js';
import { createMapping, saveMapping, loadRawMapping, mergeMapping, hasMapping, decryptMapping } from '../core/mapper.js';
import { getOrCreateSecret, hasSecret, decryptReplacements } from '../core/crypto.js';
import { isGitRepo, getChangedFiles, getRecentCommits, getFilesChangedInCommits } from '../core/git.js';

export async function pull(options = {}) {
    try {
        let destDir = null;
        let existingMapping = null;
        let existingReplacements = [];
        let sourceDir = null;
        let isQuickAdd = false;

        // Step 1: Check if current directory is already a cloaked directory
        const currentDir = process.cwd();

        if (hasMapping(currentDir) && !options.dest) {
            // Running from inside an existing cloaked directory - auto-detect!
            destDir = currentDir;
            existingMapping = loadRawMapping(destDir);

            if (!options.force) {
                console.log(chalk.cyan('\n   Existing cloaked directory detected'));
                console.log(chalk.dim(`   Created: ${existingMapping.timestamp}`));
                console.log(chalk.dim(`   Files: ${existingMapping.stats?.totalFiles || existingMapping.files?.length || 0}`));
                console.log(chalk.dim(`   Replacements: ${existingMapping.replacements?.length || 0}\n`));
            }

            if (options.force) {
                isQuickAdd = true;
                console.log(chalk.cyan('\n   Restoring missing/outdated files from source...'));
            } else {
                // Ask if they want quick-add mode
                const { mode } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'mode',
                        message: 'What would you like to do?',
                        choices: [
                            {
                                name: 'Quick Add - Use existing replacements and add more files',
                                value: 'quick'
                            },
                            {
                                name: 'Add More Replacements - Add files with additional anonymization',
                                value: 'extend'
                            },
                            {
                                name: 'Fresh Start - Choose new destination',
                                value: 'fresh'
                            }
                        ]
                    }
                ]);

                if (mode === 'fresh') {
                    // Get a new destination
                    destDir = await promptDestinationDirectory();
                    existingMapping = null;
                } else {
                    isQuickAdd = mode === 'quick';
                }
            }

            if (existingMapping) {
                // Decrypt existing replacements
                if (existingMapping.encrypted && hasSecret()) {
                    const secret = getOrCreateSecret();
                    try {
                        const decrypted = decryptReplacements(existingMapping.replacements || [], secret);
                        existingReplacements = decrypted.filter(r => !r.decryptFailed);

                        if (existingReplacements.length > 0 && !options.force) {
                            console.log(chalk.green('   Existing replacements loaded:\n'));
                            existingReplacements.forEach(r => {
                                console.log(chalk.dim(`      "${r.original}" → "${r.replacement}"`));
                            });
                            console.log('');
                        }
                    } catch (err) {
                        console.log(chalk.yellow('   Could not decrypt existing replacements'));
                    }
                } else if (!existingMapping.encrypted && existingMapping.replacements) {
                    // Not encrypted - use directly
                    existingReplacements = existingMapping.replacements;

                    if (existingReplacements.length > 0 && !options.force) {
                        console.log(chalk.green('   Existing replacements loaded:\n'));
                        existingReplacements.forEach(r => {
                            console.log(chalk.dim(`      "${r.original}" → "${r.replacement}"`));
                        });
                        console.log('');
                    }
                }

                // Try to get original source path
                if (existingMapping.encrypted && hasSecret()) {
                    const secret = getOrCreateSecret();
                    try {
                        const decrypted = decryptMapping(existingMapping, secret);
                        if (decrypted.source?.path && existsSync(decrypted.source.path)) {
                            sourceDir = decrypted.source.path;
                            if (!options.force) {
                                console.log(chalk.dim(`   Source: ${sourceDir}\n`));
                            }
                        }
                    } catch (err) {
                        // Source path couldn't be decrypted, will prompt
                    }
                } else if (!existingMapping.encrypted && existingMapping.source?.path) {
                    // Not encrypted - use directly
                    if (existsSync(existingMapping.source.path)) {
                        sourceDir = existingMapping.source.path;
                        if (!options.force) {
                            console.log(chalk.dim(`   Source: ${sourceDir}\n`));
                        }
                    }
                }
            }
        } else {
            // Not running from a cloaked directory - ask for destination
            if (options.force) {
                showError('Force flag can only be used within an existing cloaked directory.');
                return;
            }

            destDir = options.dest
                ? resolve(options.dest)
                : await promptDestinationDirectory();

            // Check if the chosen destination has an existing mapping
            if (existsSync(destDir) && hasMapping(destDir)) {
                existingMapping = loadRawMapping(destDir);

                if (!options.force) {
                    console.log(chalk.cyan('\n   Existing cloaked directory detected'));
                    console.log(chalk.dim(`   Created: ${existingMapping.timestamp}`));
                    console.log(chalk.dim(`   Files: ${existingMapping.stats?.totalFiles || existingMapping.files?.length || 0}`));
                    console.log(chalk.dim(`   Replacements: ${existingMapping.replacements?.length || 0}\n`));
                }

                if (options.force) {
                    isQuickAdd = true;
                    console.log(chalk.cyan('\n   Restoring missing/outdated files from source...'));
                } else {
                    // Ask if they want quick-add mode
                    const { mode } = await inquirer.prompt([
                        {
                            type: 'list',
                            name: 'mode',
                            message: 'What would you like to do?',
                            choices: [
                                { name: 'Quick Add - Use existing replacements and add more files', value: 'quick' },
                                { name: 'Add More Replacements - Add files with additional anonymization', value: 'extend' },
                                { name: 'Fresh Start - Choose new destination', value: 'fresh' }
                            ]
                        }
                    ]);

                    if (mode === 'fresh') {
                        destDir = await promptDestinationDirectory();
                        existingMapping = null;
                    } else {
                        isQuickAdd = mode === 'quick';
                    }
                }

                if (existingMapping) {
                    // Decrypt existing replacements
                    if (existingMapping.encrypted && hasSecret()) {
                        const secret = getOrCreateSecret();
                        try {
                            const decrypted = decryptReplacements(existingMapping.replacements || [], secret);
                            existingReplacements = decrypted.filter(r => !r.decryptFailed);

                            if (existingReplacements.length > 0 && !options.force) {
                                console.log(chalk.green('   Existing replacements loaded:\n'));
                                existingReplacements.forEach(r => {
                                    console.log(chalk.dim(`      "${r.original}" → "${r.replacement}"`));
                                });
                                console.log('');
                            }
                        } catch (err) {
                            console.log(chalk.yellow('   Could not decrypt existing replacements'));
                        }
                    } else if (!existingMapping.encrypted && existingMapping.replacements) {
                        // Not encrypted - use directly
                        existingReplacements = existingMapping.replacements;
                        if (existingReplacements.length > 0 && !options.force) {
                            console.log(chalk.green('   Existing replacements loaded:\n'));
                            existingReplacements.forEach(r => {
                                console.log(chalk.dim(`      "${r.original}" → "${r.replacement}"`));
                            });
                            console.log('');
                        }
                    }



                    // Try to get original source path
                    if (existingMapping.encrypted && hasSecret()) {
                        const secret = getOrCreateSecret();
                        try {
                            const decrypted = decryptMapping(existingMapping, secret);
                            if (decrypted.source?.path && existsSync(decrypted.source.path)) {
                                sourceDir = decrypted.source.path;
                                if (!options.force) {
                                    console.log(chalk.dim(`   Source: ${sourceDir}\n`));
                                }
                            }
                        } catch (err) {
                            // Source path couldn't be decrypted, will prompt
                        }
                    } else if (!existingMapping.encrypted && existingMapping.source?.path) {
                        if (existsSync(existingMapping.source.path)) {
                            sourceDir = existingMapping.source.path;
                            if (!options.force) {
                                console.log(chalk.dim(`   Source: ${sourceDir}\n`));
                            }
                        }
                    }
                }
            }
        }

        // ...

        // Step 3: Get source directory if not already determined
        if (!sourceDir) {
            sourceDir = options.source
                ? resolve(options.source)
                : await promptSourceDirectory();
        }

        if (!existsSync(sourceDir)) {
            showError(`Source directory does not exist: ${sourceDir}`);
            return;
        }

        if (!options.force) {
            console.log(chalk.dim(`   Source: ${sourceDir}\n`));
        }

        // Step 4: Select files (Check for Git integration first)
        let selectedFiles = [];
        let useGitFiles = false;

        if (options.force) {
            // In force mode, we just re-pull all files that are in the mapping
            if (existingMapping && existingMapping.files) {
                // We need to reconstruct the absolute paths to the source files
                // The mapping stores 'original' as relative path to sourceDir
                // But we need to check if we can decrypt them
                let filesToPull = [];

                if (existingMapping.encrypted) {
                    // We already decrypted the files list earlier if possible
                    // But let's be sure we have the decrypted file list
                    if (existingMapping.files[0]?.original.iv) {
                        // Still encrypted - we need the secret
                        const secret = getOrCreateSecret();
                        try {
                            const decryptedFiles = existingMapping.files.map(f => ({
                                original: decrypt(f.original, secret),
                                cloaked: f.cloaked
                            }));
                            filesToPull = decryptedFiles;
                        } catch (e) {
                            showError('Could not decrypt file list. Cannot force pull.');
                            return;
                        }
                    } else {
                        // Already decrypted or never encrypted
                        filesToPull = existingMapping.files;
                    }
                } else {
                    filesToPull = existingMapping.files;
                }

                selectedFiles = filesToPull.map(f => resolve(sourceDir, f.original));

                // NEW: Also scan local directory for files that might exist here but not in mapping
                try {
                    const localFiles = getAllFiles(destDir);
                    // Create reverse replacements for deanonymizing paths
                    const reverseReplacements = existingReplacements.map(r => ({
                        original: r.replacement,
                        replacement: r.original
                    }));

                    // Helper to reverse anonymize path
                    const reverseAnonymize = (path) => {
                        let result = path;
                        for (const { original, replacement } of reverseReplacements) {
                            const regex = new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                            result = result.replace(regex, replacement);
                        }
                        return result;
                    };

                    let addedCount = 0;
                    localFiles.forEach(file => {
                        // Get path relative to destDir
                        const relativeDestPath = relative(destDir, file.absolutePath);

                        // Reverse anonymize to get potential source path
                        const relativeSourcePath = reverseAnonymize(relativeDestPath);
                        const absoluteSourcePath = resolve(sourceDir, relativeSourcePath);

                        // Check if this file exists in source
                        if (existsSync(absoluteSourcePath)) {
                            // Add to selectedFiles if not already there
                            if (!selectedFiles.includes(absoluteSourcePath)) {
                                selectedFiles.push(absoluteSourcePath);
                                addedCount++;
                            }
                        }
                    });

                    if (addedCount > 0) {
                        console.log(chalk.cyan(`   Found ${addedCount} additional local files to sync from source.`));
                    }
                } catch (err) {
                    // Ignore scanning errors
                }

                if (selectedFiles.length > 0) {
                    console.log(chalk.cyan(`   Force pulling ${selectedFiles.length} files...`));
                } else {
                    showError('No files found to pull (checked mapping and local directory).');
                    return;
                }
            } else {
                showError('No files found in existing mapping.');
                return;
            }
        } else if (!isGitRepo(sourceDir) && (options.commit || options.listCommits !== undefined)) {
            showError('Source directory is not a Git repository. Cannot use commit flags.');
            return;
        } else if (isGitRepo(sourceDir)) {
            if (options.commit) {
                const spinner = ora('Fetching files from commits...').start();
                const commitFiles = await getFilesChangedInCommits(sourceDir, options.commit);
                spinner.stop();

                if (commitFiles.length === 0) {
                    showError('No files found in the specified commits.');
                    return;
                }

                // Filter to absolute paths and exist check
                const validCommitFiles = commitFiles
                    .map(f => resolve(sourceDir, f))
                    .filter(f => existsSync(f));

                if (validCommitFiles.length > 0) {
                    console.log(chalk.green(`   Found ${validCommitFiles.length} files in specified commits.`));
                    selectedFiles = validCommitFiles;
                    useGitFiles = true;
                } else {
                    showError('None of the files from the specified commits exist locally.');
                    return;
                }
            } else if (options.listCommits !== undefined) {
                const count = options.listCommits === true ? 10 : parseInt(options.listCommits, 10) || 10;
                const commits = await getRecentCommits(sourceDir, count);

                if (commits.length === 0) {
                    showError('No commits found in the repository.');
                    return;
                }

                const { selectedCommits } = await inquirer.prompt([
                    {
                        type: 'checkbox',
                        name: 'selectedCommits',
                        message: 'Select commits to extract files from:',
                        choices: commits.map(c => ({
                            name: `${c.hash} - ${c.message}`,
                            value: c.hash
                        }))
                    }
                ]);

                if (selectedCommits.length === 0) {
                    showError('No commits selected. Aborting.');
                    return;
                }

                const spinner = ora('Fetching files from selected commits...').start();
                const commitFiles = await getFilesChangedInCommits(sourceDir, selectedCommits);
                spinner.stop();
                
                if (commitFiles.length === 0) {
                    showError('No files found in the selected commits.');
                    return;
                }

                const validCommitFiles = commitFiles
                    .map(f => resolve(sourceDir, f))
                    .filter(f => existsSync(f));

                if (validCommitFiles.length > 0) {
                    console.log(chalk.green(`   Found ${validCommitFiles.length} files in selected commits.`));
                    selectedFiles = validCommitFiles;
                    useGitFiles = true;
                } else {
                    showError('None of the files from the selected commits exist locally.');
                    return;
                }
            } else {
                const { gitAction } = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'gitAction',
                        message: 'Git repository detected. How would you like to select files?',
                        choices: [
                            { name: 'Uncommitted changes (working directory)', value: 'uncommitted' },
                            { name: 'Files from recent commits', value: 'commits' },
                            { name: 'Manual selection (bypasses git)', value: 'manual' }
                        ]
                    }
                ]);

                if (gitAction === 'commits') {
                    const commits = await getRecentCommits(sourceDir, 10);
                    if (commits.length === 0) {
                        console.log(chalk.yellow('   No commits found in the repository.'));
                    } else {
                        const { selectedCommits } = await inquirer.prompt([
                            {
                                type: 'checkbox',
                                name: 'selectedCommits',
                                message: 'Select commits to extract files from:',
                                choices: commits.map(c => ({
                                    name: `${c.hash} - ${c.message}`,
                                    value: c.hash
                                }))
                            }
                        ]);

                        if (selectedCommits.length > 0) {
                            const spinner = ora('Fetching files from selected commits...').start();
                            const commitFiles = await getFilesChangedInCommits(sourceDir, selectedCommits);
                            spinner.stop();
                            
                            const validCommitFiles = commitFiles
                                .map(f => resolve(sourceDir, f))
                                .filter(f => existsSync(f));

                            if (validCommitFiles.length > 0) {
                                console.log(chalk.green(`   Found ${validCommitFiles.length} files in selected commits.`));
                                selectedFiles = validCommitFiles;
                                useGitFiles = true;
                            } else {
                                console.log(chalk.yellow('   None of the files from the selected commits exist locally.'));
                            }
                        }
                    }
                } else if (gitAction === 'uncommitted') {
                    const spinner = ora('Scanning uncommitted files...').start();
                    const gitFiles = await getChangedFiles(sourceDir);
                    spinner.stop();

                    if (gitFiles.length === 0) {
                        console.log(chalk.yellow('   No uncommitted files found in Git status.'));
                    } else {
                        const validGitFiles = gitFiles
                            .map(f => resolve(sourceDir, f))
                            .filter(f => existsSync(f));

                        if (validGitFiles.length > 0) {
                            console.log(chalk.green(`   Found ${validGitFiles.length} changed files.`));

                            const { confirmGitFiles } = await inquirer.prompt([
                                {
                                    type: 'checkbox',
                                    name: 'confirmGitFiles',
                                    message: 'Select changed files to extract:',
                                    choices: validGitFiles.map(f => ({
                                        name: relative(sourceDir, f),
                                        value: f,
                                        checked: true
                                    }))
                                }
                            ]);

                            selectedFiles = confirmGitFiles;
                            useGitFiles = true;
                        }
                    }
                }
            }
        }

        if (!options.force && (!useGitFiles || selectedFiles.length === 0)) {
            selectedFiles = await selectFiles(sourceDir);
        }

        if (selectedFiles.length === 0) {
            showError('No files selected. Aborting.');
            return;
        }

        if (!options.force) {
            console.log(chalk.green(`\n✓ Selected ${selectedFiles.length} files\n`));
        }

        // Step 4.5: Scan for Secrets
        if (!options.force) {
            const scanSpinner = ora('Scanning selected files for sensitive data...').start();
            const secretFindings = await scanFilesForSecrets(selectedFiles);
            scanSpinner.stop();

            if (secretFindings.length > 0) {
                console.log(chalk.red.bold('\n⚠️  WARNING: POTENTIAL SENSITIVE DATA DETECTED ⚠️\n'));
                
                // Group by file to present a cleaner list
                const findingsByFile = secretFindings.reduce((acc, finding) => {
                    const relPath = relative(sourceDir, finding.file);
                    if (!acc[relPath]) acc[relPath] = new Set();
                    acc[relPath].add(`${finding.type} (Line ${finding.line})`);
                    return acc;
                }, {});

                for (const [file, secrets] of Object.entries(findingsByFile)) {
                    console.log(chalk.yellow(`   ${file}:`));
                    for (const secret of secrets) {
                        console.log(chalk.dim(`      - ${secret}`));
                    }
                }
                console.log('');

                const { proceedWithSecrets } = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'proceedWithSecrets',
                        message: 'Are you sure you want to proceed extracting these files?',
                        default: false
                    }
                ]);

                if (!proceedWithSecrets) {
                    showInfo('Operation cancelled to protect sensitive data.');
                    return;
                }
                console.log('');
            }
        }

        // Step 5: Handle replacements based on mode
        let replacements = [...existingReplacements];

        if (!options.force) {
            if (isQuickAdd) {
                // Quick add mode - just use existing replacements
                if (replacements.length > 0) {
                    console.log(chalk.cyan('   Using existing replacements (quick-add mode)\n'));
                }

                // Ask if they want to add more
                const { addMore } = await inquirer.prompt([
                    {
                        type: 'confirm',
                        name: 'addMore',
                        message: 'Add additional replacements?',
                        default: false
                    }
                ]);

                if (addMore) {
                    const additionalReplacements = await promptKeywordReplacements();
                    replacements = [...replacements, ...additionalReplacements];
                }
            } else if (existingMapping) {
                // Extend mode - prompt for more replacements to add to existing
                console.log(chalk.cyan('\n   Add more replacements (existing will be preserved):\n'));
                const additionalReplacements = await promptKeywordReplacements();
                replacements = [...replacements, ...additionalReplacements];
            } else {
                // Fresh start - prompt for all replacements
                replacements = await promptKeywordReplacements();
            }
        }

        // Step 6: Confirm
        if (!options.force) {
            const confirmed = await showSummaryAndConfirm(
                selectedFiles.length,
                destDir,
                replacements
            );

            if (!confirmed) {
                showInfo('Operation cancelled.');
                return;
            }
        }

        // Step 7: Create destination directory
        if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
            console.log(chalk.dim(`   Created directory: ${destDir}`));
        }

        // Step 8: Copy and anonymize files
        const spinner = ora('Copying and anonymizing files...').start();

        const anonymizer = createAnonymizer(replacements);
        let lastFile = '';

        const results = await copyFiles(
            selectedFiles,
            sourceDir,
            destDir,
            anonymizer,
            (current, total, file) => {
                lastFile = file;
                spinner.text = `Copying files... ${current}/${total} - ${file}`;
            },
            replacements  // Pass replacements for path anonymization
        );

        spinner.succeed(`Copied ${results.copied} files`);

        if (results.pathsRenamed > 0) {
            console.log(chalk.cyan(`   📁 ${results.pathsRenamed} paths renamed`));
        }

        if (results.transformed > 0) {
            console.log(chalk.cyan(`   📝 ${results.transformed} files had content replaced`));
        }

        if (results.errors.length > 0) {
            console.log(chalk.yellow(`   ⚠️  ${results.errors.length} files had errors`));
            results.errors.forEach(e => {
                console.log(chalk.dim(`      - ${e.file}: ${e.error}`));
            });
        }

        // Step 8.5: Write AGENTS.md into the cloaked workspace
        if (!existingMapping) {
            const agentsPath = join(destDir, 'AGENTS.md');
            writeFileSync(agentsPath, getAgentsMarkdown(), 'utf-8');
            console.log(chalk.cyan(`   🤖 AGENTS.md created for AI agent context`));
        }

        // Step 9: Prepare new file mappings
        const newFiles = selectedFiles.map(f => {
            const originalPath = relative(sourceDir, f);
            let anonymizedPath = originalPath;
            for (const { original, replacement } of replacements) {
                const regex = new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                anonymizedPath = anonymizedPath.replace(regex, replacement);
            }
            return {
                original: originalPath,
                cloaked: anonymizedPath
            };
        });

        // Step 10: Check for existing mapping and merge if found
        let mapping;
        let isIncremental = false;

        if (existingMapping) {
            // Merge with existing
            mapping = mergeMapping(existingMapping, newFiles);
            isIncremental = true;
            console.log(chalk.cyan(`   🔄 Merged with existing mapping`));
        } else {
            // Create new mapping
            mapping = createMapping({
                sourceDir,
                destDir,
                replacements,
                files: newFiles
            });
        }

        const mapPath = saveMapping(destDir, mapping);

        if (isIncremental) {
            const history = mapping.pullHistory || [];
            const lastPull = history[history.length - 1];
            console.log(chalk.dim(`   📋 Mapping updated: ${lastPull?.filesAdded || 0} new files added (total: ${mapping.stats?.totalFiles})`));
        } else {
            console.log(chalk.dim(`   📋 Mapping saved: ${mapPath}`));
        }

        // Done!
        showSuccess('Extraction complete!');
        console.log(chalk.white(`   📂 Files extracted to: ${chalk.cyan.bold(destDir)}`));

        if (isQuickAdd || isIncremental) {
            console.log(chalk.dim(`\n   Tip: Run again to add more files quickly\n`));
        } else {
            console.log(chalk.dim(`\n   To restore later, run: ${chalk.white('repo-cloak push')}\n`));
        }

    } catch (error) {
        showError(`Pull failed: ${error.message}`);
        if (process.env.DEBUG) {
            console.error(error);
        }
    }
}
