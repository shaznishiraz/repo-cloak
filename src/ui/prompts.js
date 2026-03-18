/**
 * User Prompts
 * Handles all user input prompts
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { existsSync, mkdirSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { getSourcePaths, getDestPaths, addSourcePath, addDestPath } from '../core/path-cache.js';

const ENTER_DIFFERENT = '__ENTER_DIFFERENT__';

/**
 * Build a list prompt with cached paths + "Enter a different path" option.
 * Falls back to a plain input prompt when there are no cached paths.
 * @param {object} opts
 * @param {string}   opts.message        - Question shown to the user
 * @param {string}   opts.inputMessage   - Follow-up message when they pick "Enter a different path"
 * @param {string[]} opts.cachedPaths    - Decrypted cached paths to show
 * @param {(path: string) => string|true} opts.validate - Validator for the final resolved path
 * @returns {Promise<string>} Resolved absolute path
 */
async function promptWithCache({ message, inputMessage, cachedPaths, validate }) {
    // If we have cached paths, show a list first
    if (cachedPaths.length > 0) {
        const { selected } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selected',
                message,
                choices: [
                    ...cachedPaths.map(p => ({ name: p, value: p })),
                    new inquirer.Separator(),
                    { name: chalk.cyan('↵  Enter a different path'), value: ENTER_DIFFERENT }
                ]
            }
        ]);

        if (selected !== ENTER_DIFFERENT) {
            const resolved = resolve(selected);
            const result = validate(resolved);
            if (result !== true) {
                console.log(chalk.yellow(`   ⚠  ${result}`));
                // Offer plain input as fallback
            } else {
                return resolved;
            }
        }
    }

    // Plain input fallback (no cache or user chose "Enter a different path")
    const { manualPath } = await inquirer.prompt([
        {
            type: 'input',
            name: 'manualPath',
            message: inputMessage,
            validate: (input) => {
                if (!input.trim()) return 'Please enter a path.';
                return validate(resolve(input.trim()));
            }
        }
    ]);

    return resolve(manualPath.trim());
}

/**
 * Prompt for source directory (the repo to extract files from).
 * Shows cached paths; validates that the directory exists.
 * Saves the chosen path to the cache after selection.
 */
export async function promptSourceDirectory() {
    const cachedPaths = getSourcePaths();

    const path = await promptWithCache({
        message:      'Which repo do you want to extract files from?',
        inputMessage: 'Type or paste the path to your source repo:',
        cachedPaths,
        validate: (resolved) => {
            if (!existsSync(resolved)) {
                return `Directory not found: ${resolved}`;
            }
            return true;
        }
    });

    addSourcePath(path);
    return path;
}

/**
 * Prompt for destination directory (where cloaked files will be saved).
 * Shows cached paths; creates the folder automatically if it doesn't exist.
 * Saves the chosen path to the cache after selection.
 */
export async function promptDestinationDirectory() {
    const cachedPaths = getDestPaths();

    const path = await promptWithCache({
        message:      'Where should the cloaked (anonymized) files be saved?',
        inputMessage: 'Type or paste the path to your output folder (will be created if needed):',
        cachedPaths,
        validate: (resolved) => {
            if (!resolved.trim()) return 'Please enter a destination path.';
            return true; // Destination may not exist yet – we will create it
        }
    });

    // Auto-create the destination if it doesn't exist
    if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
        console.log(chalk.dim(`   Created directory: ${path}`));
    }

    addDestPath(path);
    return path;
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
                message: 'What do you want to replace? (leave empty to skip / finish):', 
            },
            {
                type: 'input',
                name: 'replacement',
                message: 'Replace it with:', 
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

    return confirmAction('Everything looks good — go ahead?');
}

/**
 * Prompt for selecting a backup folder (for push command)
 */
export async function promptBackupFolder() {
    const { folderPath } = await inquirer.prompt([
        {
            type: 'input',
            name: 'folderPath',
            message: 'Where is the cloaked folder you want to restore from?', 
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
