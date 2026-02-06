/**
 * Pull Command
 * Extract files and anonymize sensitive information
 */

import ora from 'ora';
import chalk from 'chalk';
import { existsSync, mkdirSync } from 'fs';
import { resolve, relative } from 'path';

import { selectFiles } from '../ui/fileSelector.js';
import {
    promptSourceDirectory,
    promptDestinationDirectory,
    promptKeywordReplacements,
    showSummaryAndConfirm
} from '../ui/prompts.js';
import { showSuccess, showError, showInfo } from '../ui/banner.js';
import { getAllFiles } from '../core/scanner.js';
import { copyFiles } from '../core/copier.js';
import { createAnonymizer } from '../core/anonymizer.js';
import { createMapping, saveMapping } from '../core/mapper.js';

export async function pull(options = {}) {
    try {
        // Step 1: Get source directory
        const sourceDir = options.source
            ? resolve(options.source)
            : await promptSourceDirectory();

        if (!existsSync(sourceDir)) {
            showError(`Source directory does not exist: ${sourceDir}`);
            return;
        }

        console.log(chalk.dim(`\n   Source: ${sourceDir}\n`));

        // Step 2: Select files
        const selectedFiles = await selectFiles(sourceDir);

        if (selectedFiles.length === 0) {
            showError('No files selected. Aborting.');
            return;
        }

        console.log(chalk.green(`\n✓ Selected ${selectedFiles.length} files\n`));

        // Step 3: Get destination directory
        const destDir = options.dest
            ? resolve(options.dest)
            : await promptDestinationDirectory();

        // Step 4: Get keyword replacements
        const replacements = await promptKeywordReplacements();

        // Step 5: Confirm
        const confirmed = await showSummaryAndConfirm(
            selectedFiles.length,
            destDir,
            replacements
        );

        if (!confirmed) {
            showInfo('Operation cancelled.');
            return;
        }

        // Step 6: Create destination directory
        if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
            console.log(chalk.dim(`   Created directory: ${destDir}`));
        }

        // Step 7: Copy and anonymize files
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
            }
        );

        spinner.succeed(`Copied ${results.copied} files`);

        if (results.transformed > 0) {
            console.log(chalk.cyan(`   📝 ${results.transformed} files had content replaced`));
        }

        if (results.errors.length > 0) {
            console.log(chalk.yellow(`   ⚠️  ${results.errors.length} files had errors`));
            results.errors.forEach(e => {
                console.log(chalk.dim(`      - ${e.file}: ${e.error}`));
            });
        }

        // Step 8: Save mapping file
        const mapping = createMapping({
            sourceDir,
            destDir,
            replacements,
            files: selectedFiles.map(f => ({
                relativePath: relative(sourceDir, f)
            }))
        });

        const mapPath = saveMapping(destDir, mapping);
        console.log(chalk.dim(`   📋 Mapping saved: ${mapPath}`));

        // Done!
        showSuccess('Extraction complete!');
        console.log(chalk.white(`   📂 Files extracted to: ${chalk.cyan.bold(destDir)}`));
        console.log(chalk.dim(`\n   To restore later, run: ${chalk.white('repo-cloak push')}\n`));

    } catch (error) {
        showError(`Pull failed: ${error.message}`);
        if (process.env.DEBUG) {
            console.error(error);
        }
    }
}
