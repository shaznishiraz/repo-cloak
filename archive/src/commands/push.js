/**
 * Push Command
 * Restore files with original names from a cloaked backup
 * Now with decryption support!
 */

import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

import {
    promptBackupFolder,
    promptDestinationDirectory,
    confirmAction
} from '../ui/prompts.js';
import { showSuccess, showError, showInfo, showWarning } from '../ui/banner.js';
import { getAllFiles } from '../core/scanner.js';
import { copyFiles } from '../core/copier.js';
import { createDeanonymizer } from '../core/anonymizer.js';
import { loadMapping, hasMapping, getReplacements, getOriginalSource, decryptMapping } from '../core/mapper.js';
import { getOrCreateSecret, hasSecret, decrypt, getConfigDir } from '../core/crypto.js';

export async function push(options = {}) {
    try {
        // Step 1: Check if current directory has a mapping (auto-detect)
        const currentDir = process.cwd();
        let cloakedDir;

        if (hasMapping(currentDir) && !options.source) {
            // Running from inside a cloaked directory - use it directly
            cloakedDir = currentDir;
            console.log(chalk.cyan('\n   Cloaked directory detected in current folder'));
        } else {
            // Ask for the source directory
            cloakedDir = options.source
                ? resolve(options.source)
                : await promptBackupFolder();
        }

        if (!existsSync(cloakedDir)) {
            showError(`Directory does not exist: ${cloakedDir}`);
            return;
        }

        // Step 2: Check for mapping file
        if (!hasMapping(cloakedDir)) {
            showError('No repo-cloak mapping file found in this directory.');
            console.log(chalk.dim('   Make sure you selected a directory created by "repo-cloak pull"'));
            return;
        }

        // Step 3: Load mapping (without decryption first to check if encrypted)
        const spinner = ora('Loading mapping file...').start();
        let rawMapping = loadMapping(cloakedDir);
        spinner.succeed('Mapping file loaded');

        let mapping = rawMapping;
        let decryptionFailed = false;

        // Step 4: Handle encryption
        if (rawMapping.encrypted) {
            console.log(chalk.cyan('\n   🔐 This backup was encrypted'));

            if (hasSecret()) {
                const secret = getOrCreateSecret();
                try {
                    mapping = decryptMapping(rawMapping, secret);
                    console.log(chalk.green('   ✓ Decrypted successfully using your secret key'));
                } catch (error) {
                    decryptionFailed = true;
                    console.log(chalk.yellow('   ⚠️  Decryption failed with your current secret'));
                }
            } else {
                decryptionFailed = true;
                console.log(chalk.yellow(`   ⚠️  No secret key found at ${getConfigDir()}`));
            }

            // If decryption failed, ask user for manual input
            if (decryptionFailed) {
                console.log(chalk.yellow('\n   Your secret key may have been lost or changed.'));
                console.log(chalk.dim('   You can manually provide the original keywords to restore.\n'));

                const manualReplacements = [];

                for (const r of rawMapping.replacements || []) {
                    const { original } = await inquirer.prompt([
                        {
                            type: 'input',
                            name: 'original',
                            message: `What was the original text for "${r.replacement}"?`,
                            prefix: '🔑'
                        }
                    ]);

                    if (original.trim()) {
                        manualReplacements.push({
                            original: original.trim(),
                            replacement: r.replacement
                        });
                    }
                }

                mapping = {
                    ...rawMapping,
                    replacements: manualReplacements,
                    source: { path: null },
                    destination: { path: null },
                    files: (rawMapping.files || []).map(f => ({
                        original: f.cloaked, // Use cloaked as original if can't decrypt
                        cloaked: f.cloaked
                    }))
                };
            }
        }

        // Display info
        const sourcePath = getOriginalSource(mapping);
        console.log(chalk.dim(`\n   Original source: ${sourcePath || 'Unknown (encrypted)'}`));
        console.log(chalk.dim(`   Extracted on: ${mapping.timestamp}`));
        console.log(chalk.dim(`   Replacements: ${mapping.replacements?.length || 0}`));
        console.log(chalk.dim(`   Files: ${mapping.files?.length || 0}\n`));

        // Show replacements that will be reversed
        if (mapping.replacements && mapping.replacements.length > 0) {
            console.log(chalk.cyan('   Replacements to reverse:'));
            mapping.replacements.forEach(r => {
                if (r.original) {
                    console.log(chalk.dim(`      "${r.replacement}" → "${r.original}"`));
                } else {
                    console.log(chalk.yellow(`      "${r.replacement}" → [ENCRYPTED]`));
                }
            });
            console.log('');
        }

        // Step 5: Get destination directory
        let destDir;

        if (options.dest) {
            destDir = resolve(options.dest);
        } else if (sourcePath && existsSync(sourcePath)) {
            if (options.force) {
                // If force is used and source path exists, use it automatically
                destDir = sourcePath;
            } else {
                const useOriginal = await confirmAction(
                    `Restore to original location? (${sourcePath})`
                );

                if (useOriginal) {
                    destDir = sourcePath;
                } else {
                    destDir = await promptDestinationDirectory();
                }
            }
        } else {
            if (sourcePath) {
                console.log(chalk.yellow(`   Original path no longer exists: ${sourcePath}`));
            }

            if (options.force) {
                showError('Original source path not found and no destination provided. Cannot force push.');
                return;
            }
            destDir = await promptDestinationDirectory();
        }

        // Step 6: Confirm
        if (!options.force) {
            const confirmed = await confirmAction(
                `Restore ${mapping.files?.length || 0} files to ${destDir}?`
            );

            if (!confirmed) {
                showInfo('Operation cancelled.');
                return;
            }
        } else {
            // Log what we are doing in force mode
            console.log(chalk.cyan(`\n   Force restoring ${mapping.files?.length || 0} files to ${destDir}...`));
        }

        // Step 7: Get all files from cloaked directory
        const files = getAllFiles(cloakedDir);

        if (files.length === 0) {
            showWarning('No files found in the cloaked directory.');
            return;
        }

        // Step 8: Create destination if needed
        if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
            console.log(chalk.dim(`   Created directory: ${destDir}`));
        }

        // Step 9: Copy and de-anonymize files
        const restoreSpinner = ora('Restoring files...').start();

        // Filter out any replacements where decryption failed
        const validReplacements = (mapping.replacements || []).filter(r => r.original);
        const deanonymizer = createDeanonymizer(validReplacements);

        // Also pass reversed replacements for path restoration
        const reversedReplacements = validReplacements.map(r => ({
            original: r.replacement,
            replacement: r.original
        }));

        const results = await copyFiles(
            files,
            cloakedDir,
            destDir,
            deanonymizer,
            (current, total, file) => {
                restoreSpinner.text = `Restoring files... ${current}/${total} - ${file}`;
            },
            reversedReplacements // Pass for path de-anonymization
        );

        restoreSpinner.succeed(`Restored ${results.copied} files`);

        if (results.pathsRenamed > 0) {
            console.log(chalk.cyan(`   📁 ${results.pathsRenamed} paths restored`));
        }

        if (results.transformed > 0) {
            console.log(chalk.cyan(`   📝 ${results.transformed} files had content restored`));
        }

        if (results.errors.length > 0) {
            console.log(chalk.yellow(`   ⚠️  ${results.errors.length} files had errors`));
            results.errors.forEach(e => {
                console.log(chalk.dim(`      - ${e.file}: ${e.error}`));
            });
        }

        // Done!
        showSuccess('Restoration complete!');
        console.log(chalk.white(`   📂 Files restored to: ${chalk.cyan.bold(destDir)}\n`));

    } catch (error) {
        showError(`Push failed: ${error.message}`);
        if (process.env.DEBUG) {
            console.error(error);
        }
    }
}
