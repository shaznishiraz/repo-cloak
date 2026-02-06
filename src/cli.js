/**
 * CLI Command Router
 * Handles command-line arguments and routes to appropriate handlers
 */

import { Command } from 'commander';
import { showBanner } from './ui/banner.js';
import { pull } from './commands/pull.js';
import { push } from './commands/push.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const packageJson = JSON.parse(
    readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
);

const program = new Command();

program
    .name('repo-cloak')
    .description('🎭 Selectively extract and anonymize files from repositories')
    .version(packageJson.version);

program
    .command('pull')
    .description('Extract files and anonymize sensitive information')
    .option('-s, --source <path>', 'Source directory (default: current directory)')
    .option('-d, --dest <path>', 'Destination directory')
    .option('-q, --quiet', 'Minimal output')
    .action(async (options) => {
        await showBanner();
        await pull(options);
    });

program
    .command('push')
    .description('Restore files with original names from a cloaked backup')
    .option('-s, --source <path>', 'Source cloaked directory')
    .option('-d, --dest <path>', 'Destination directory (original location)')
    .option('-q, --quiet', 'Minimal output')
    .action(async (options) => {
        await showBanner();
        await push(options);
    });

// Default command (no subcommand) - show interactive menu
program
    .action(async () => {
        await showBanner();
        const { default: inquirer } = await import('inquirer');

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'What would you like to do?',
                choices: [
                    { name: '📤 Pull - Extract & anonymize files', value: 'pull' },
                    { name: '📥 Push - Restore files with original names', value: 'push' },
                    { name: '❌ Exit', value: 'exit' }
                ]
            }
        ]);

        if (action === 'pull') {
            await pull({});
        } else if (action === 'push') {
            await push({});
        }
    });

export async function run() {
    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}
