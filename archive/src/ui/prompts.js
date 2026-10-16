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
import { checkboxTreeSelectSingleDir } from './treeCheckboxSelector.js';

/**
 * Build a list prompt with cached paths + "Enter a different path" option.
 * Falls back to a plain input prompt when there are no cached paths.
 * @param {object} opts
 * @param {string}   opts.message        - Question shown to the user
 * @param {string}   opts.inputMessage   - Follow-up message when they pick "Enter a different path"
 * @param {string[]} opts.cachedPaths    - Decrypted cached paths to show
 * @param {(path: string) => string|true} opts.validate - Validator for final resolved path
 * @param {string}   [opts.defaultValue] - Default path
 * @param {boolean}  [opts.allowNewSubfolder] - Ask to append a subfolder after selection
 * @returns {Promise<string>} Resolved absolute path
 */
async function promptWithCache({ message, cachedPaths, validate, defaultValue, allowNewSubfolder }) {
    // Build the displayed message — append a dim default hint if one is provided
    const displayMessage = defaultValue
        ? `${message} ${chalk.dim(`(press Enter to use current folder: ${defaultValue})`)}`
        : message;

    // With cached paths → show a quick-pick list with the question as its header
    if (cachedPaths.length > 0) {
        const { selected } = await inquirer.prompt([
            {
                type: 'list',
                name: 'selected',
                message: displayMessage,
                choices: [
                    ...cachedPaths.map(p => ({ name: p, value: p })),
                    new inquirer.Separator(),
                    { name: chalk.cyan('↵  Enter a different path'), value: ENTER_DIFFERENT }
                ]
            }
        ]);

        if (selected !== ENTER_DIFFERENT) {
            let resolved = resolve(selected);

            if (allowNewSubfolder) {
                const { subfolder } = await inquirer.prompt([{
                    type: 'input',
                    name: 'subfolder',
                    message: `Subfolder to create inside ${chalk.cyan(resolved)}? (press Enter to use current folder)`
                }]);
                if (subfolder.trim()) {
                    resolved = resolve(resolved, subfolder.trim());
                }
            }

            const result = validate(resolved);
            if (result !== true) {
                console.log(chalk.yellow(`   ⚠  ${result}`));
            } else {
                return resolved;
            }
        }
    }

    // No cache (or user chose "Enter a different path") → use hierarchical tree selector
    console.log(chalk.dim('   (Use arrow keys to navigate, Space to expand/collapse, Enter to select)'));
    let basePath = await checkboxTreeSelectSingleDir({
        message: displayMessage,
        root: process.cwd()
    });

    if (allowNewSubfolder) {
        const { subfolder } = await inquirer.prompt([{
            type: 'input',
            name: 'subfolder',
            message: `Subfolder to create inside ${chalk.cyan(basePath)}? (press Enter to use current folder)`
        }]);
        if (subfolder.trim()) {
            basePath = resolve(basePath, subfolder.trim());
        }
    }

    let finalPath = resolve(basePath);
    // Loop until we get a path that passes validation
    while (true) {
        const result = validate(finalPath);
        if (result === true) break;
        console.log(chalk.yellow(`   ⚠  ${result}`));
        
        const { retry } = await inquirer.prompt([{
            type: 'input',
            name: 'retry',
            message: 'Please type a valid absolute path:'
        }]);
        finalPath = resolve(retry.trim());
    }

    return finalPath;
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
        defaultValue: process.cwd(),
        allowNewSubfolder: true,
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
