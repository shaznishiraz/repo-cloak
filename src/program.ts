import { createRequire } from 'node:module';
import { Command } from 'commander';

const require = createRequire(import.meta.url);
const { version, description } = require('../package.json') as {
  version: string;
  description: string;
};

export function createProgram(): Command {
  return new Command()
    .name('repo-cloak')
    .description(description)
    .version(version, '-v, --version');
}
