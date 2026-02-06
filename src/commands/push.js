/**
 * Push Command
 * Restore files with original names from a cloaked backup
 */

import ora from 'ora';
import chalk from 'chalk';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve, join, relative } from 'path';

import {
    promptBackupFolder,
    promptDestinationDirectory,
    confirmAction
} from '../ui/prompts.js';
import { showSuccess, showError, showInfo, showWarning } from '../ui/banner.js';
import { getAllFiles } from '../core/scanner.js';
import { copyFiles } from '../core/copier.js';
import { createDeanonymizer } from '../core/anonymizer.js';
import { loadMapping, hasMapping, getReplacements, getOriginalSource } from '../core/mapper.js';

export async function push(options = {}) {
    try {
        // Step 1: Get source (cloaked) directory
        const cloakedDir = options.source
            ? resolve(options.source)
            : await promptBackupFolder();

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

        // Step 3: Load mapping
        const spinner = ora('Loading mapping file...').start();
        const mapping = loadMapping(cloakedDir);
        spinner.succeed('Mapping file loaded');

        console.log(chalk.dim(`\n   Original source: ${mapping.source?.path || 'Unknown'}`));
        console.log(chalk.dim(`   Extracted on: ${mapping.timestamp}`));
        console.log(chalk.dim(`   Replacements: ${mapping.replacements?.length || 0}`));
        console.log(chalk.dim(`   Files: ${mapping.files?.length || 0}\n`));

        // Show replacements that will be reversed
        if (mapping.replacements && mapping.replacements.length > 0) {
            console.log(chalk.cyan('   Replacements to reverse:'));
            mapping.replacements.forEach(r => {
                console.log(chalk.dim(`      "${r.replacement}" → "${r.original}"`));
            });
            console.log('');
        }

        // Step 4: Get destination directory
        const originalPath = getOriginalSource(mapping);
        let destDir;

        if (options.dest) {
            destDir = resolve(options.dest);
        } else if (originalPath && existsSync(originalPath)) {
            const useOriginal = await confirmAction(
                `Restore to original location? (${originalPath})`
            );

            if (useOriginal) {
                destDir = originalPath;
            } else {
                destDir = await promptDestinationDirectory();
            }
        } else {
            if (originalPath) {
                console.log(chalk.yellow(`   Original path no longer exists: ${originalPath}`));
            }
            destDir = await promptDestinationDirectory();
        }

        // Step 5: Confirm
        const confirmed = await confirmAction(
            `Restore ${mapping.files?.length || 0} files to ${destDir}?`
        );

        if (!confirmed) {
            showInfo('Operation cancelled.');
            return;
        }

        // Step 6: Get all files from cloaked directory
        const files = getAllFiles(cloakedDir);

        if (files.length === 0) {
            showWarning('No files found in the cloaked directory.');
            return;
        }

        // Step 7: Create destination if needed
        if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
            console.log(chalk.dim(`   Created directory: ${destDir}`));
        }

        // Step 8: Copy and de-anonymize files
        const restoreSpinner = ora('Restoring files...').start();

        const deanonymizer = createDeanonymizer(getReplacements(mapping));

        const results = await copyFiles(
            files,
            cloakedDir,
            destDir,
            deanonymizer,
            (current, total, file) => {
                restoreSpinner.text = `Restoring files... ${current}/${total} - ${file}`;
            }
        );

        restoreSpinner.succeed(`Restored ${results.copied} files`);

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
