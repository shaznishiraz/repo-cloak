/**
 * User Prompts
 * Handles all user input prompts
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';

/**
 * Prompt for source directory
 */
export async function promptSourceDirectory(defaultPath = process.cwd()) {
    const { sourcePath } = await inquirer.prompt([
        {
            type: 'input',
            name: 'sourcePath',
            message: 'Source directory:',
            default: defaultPath,
            validate: (input) => {
                const path = resolve(input);
                if (!existsSync(path)) {
                    return 'Directory does not exist. Please enter a valid path.';
                }
                return true;
            }
        }
    ]);

    return resolve(sourcePath);
}

/**
 * Prompt for destination directory
 */
export async function promptDestinationDirectory() {
    const { destPath } = await inquirer.prompt([
        {
            type: 'input',
            name: 'destPath',
            message: 'Destination directory (will be created if not exists):',
            validate: (input) => {
                if (!input.trim()) {
                    return 'Please enter a destination path.';
                }
                return true;
            }
        }
    ]);

    return resolve(destPath);
}

/**
 * Prompt for keyword replacements
 */
export async function promptKeywordReplacements() {
    const replacements = [];

    console.log(chalk.cyan('\n🔄 Keyword Replacements'));
    console.log(chalk.dim('   Replace sensitive information with anonymous values.\n'));

    let addMore = true;

    while (addMore) {
        const { original, replacement } = await inquirer.prompt([
            {
                type: 'input',
                name: 'original',
                message: 'Text to find (leave empty to finish):',
            },
            {
                type: 'input',
                name: 'replacement',
                message: 'Replace with:',
                when: (answers) => answers.original.trim() !== '',
                validate: (input) => {
                    if (!input.trim()) {
                        return 'Please enter a replacement value.';
                    }
                    return true;
                }
            }
        ]);

        if (original.trim() === '') {
            addMore = false;
        } else {
            replacements.push({
                original: original.trim(),
                replacement: replacement.trim()
            });

            console.log(chalk.green(`   ✓ "${original}" → "${replacement}"`));
        }
    }

    if (replacements.length === 0) {
        console.log(chalk.yellow('   No replacements configured. Files will be copied as-is.'));
    }

    return replacements;
}

/**
 * Confirm before proceeding
 */
export async function confirmAction(message) {
    const { confirmed } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirmed',
            message,
            default: true
        }
    ]);

    return confirmed;
}

/**
 * Show summary of selections
 */
export async function showSummaryAndConfirm(fileCount, destination, replacements) {
    console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    console.log(chalk.white.bold('📋 Summary\n'));
    console.log(chalk.white(`   📂 Files to copy: ${chalk.yellow.bold(fileCount)}`));
    console.log(chalk.white(`   📍 Destination: ${chalk.yellow.bold(destination)}`));

    if (replacements.length > 0) {
        console.log(chalk.white(`   🔄 Replacements: ${chalk.yellow.bold(replacements.length)}`));
        replacements.forEach(r => {
            console.log(chalk.dim(`      "${r.original}" → "${r.replacement}"`));
        });
    } else {
        console.log(chalk.white(`   🔄 Replacements: ${chalk.dim('None')}`));
    }

    console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    return confirmAction('Proceed with extraction?');
}

/**
 * Prompt for selecting a backup folder (for push command)
 */
export async function promptBackupFolder() {
    const { folderPath } = await inquirer.prompt([
        {
            type: 'input',
            name: 'folderPath',
            message: 'Path to cloaked backup folder:',
            validate: (input) => {
                const path = resolve(input);
                if (!existsSync(path)) {
                    return 'Folder does not exist. Please enter a valid path.';
                }
                return true;
            }
        }
    ]);

    return resolve(folderPath);
}
