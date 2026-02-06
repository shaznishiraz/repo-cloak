/**
 * Fancy ASCII Banner
 * Shows a colorful intro when the CLI starts
 */

import chalk from 'chalk';
import figlet from 'figlet';

export async function showBanner() {
    return new Promise((resolve) => {
        figlet.text('repo-cloak', {
            font: 'Standard',
            horizontalLayout: 'default',
            verticalLayout: 'default'
        }, (err, data) => {
            if (err) {
                console.log(chalk.magentaBright.bold('\n🎭 repo-cloak\n'));
                resolve();
                return;
            }

            // Create gradient effect
            const lines = data.split('\n');
            const colors = [
                chalk.hex('#FF6B6B'),  // Coral
                chalk.hex('#FF8E53'),  // Orange
                chalk.hex('#FEC89A'),  // Peach
                chalk.hex('#A8E6CF'),  // Mint
                chalk.hex('#88D8B0'),  // Seafoam
                chalk.hex('#7B68EE'),  // Medium Slate Blue
                chalk.hex('#9D4EDD'),  // Purple
            ];

            console.log('\n');
            lines.forEach((line, index) => {
                const color = colors[index % colors.length];
                console.log(color(line));
            });

            // Tagline box
            const tagline = '🎭 Selectively extract & anonymize repository files';
            const version = 'v1.0.0';

            console.log('');
            console.log(chalk.dim('─'.repeat(55)));
            console.log(chalk.white.bold(`  ${tagline}`));
            console.log(chalk.dim(`  Compatible with Windows, macOS, and Linux | ${version}`));
            console.log(chalk.dim('─'.repeat(55)));
            console.log('');

            resolve();
        });
    });
}

export function showSuccess(message) {
    console.log(chalk.green.bold(`\n✅ ${message}\n`));
}

export function showError(message) {
    console.log(chalk.red.bold(`\n❌ ${message}\n`));
}

export function showWarning(message) {
    console.log(chalk.yellow.bold(`\n⚠️  ${message}\n`));
}

export function showInfo(message) {
    console.log(chalk.cyan(`\nℹ️  ${message}\n`));
}
