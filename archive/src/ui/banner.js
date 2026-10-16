/**
 * Banner
 * Clean, elegant CLI header
 */

import chalk from 'chalk';
import figlet from 'figlet';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function getVersion() {
    try {
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
        return pkg.version || '1.0.0';
    } catch {
        return '1.0.0';
    }
}

export async function showBanner() {
    return new Promise((resolve) => {
        figlet.text('repo-cloak', {
            font: 'Slant',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        }, (err, data) => {
            const version = getVersion();

            if (err || !data) {
                console.log('\n' + chalk.bold.white('  repo-cloak') + chalk.dim(`  v${version}\n`));
                resolve();
                return;
            }

            console.log('');
            // Render the ASCII art in a single elegant dim-white color
            data.split('\n').forEach(line => {
                console.log(chalk.white.dim('  ' + line));
            });

            console.log('');
            console.log(
                chalk.dim('  Selectively extract & anonymize repository files') +
                chalk.dim(`   v${version}`)
            );
            console.log('');

            resolve();
        });
    });
}

export function showSuccess(message) {
    console.log(chalk.green(`\n  ✓ ${message}\n`));
}

export function showError(message) {
    console.log(chalk.red(`\n  ✗ ${message}\n`));
}

export function showWarning(message) {
    console.log(chalk.yellow(`\n  ! ${message}\n`));
}

export function showInfo(message) {
    console.log(chalk.dim(`\n  ${message}\n`));
}
