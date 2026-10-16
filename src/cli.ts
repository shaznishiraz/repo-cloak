import { ConflictError } from './core/errors.js';
import { createProgram } from './program.js';

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof Error && error.name === 'ExitPromptError') {
    process.exitCode = 130;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = error instanceof ConflictError ? error.exitCode : 1;
  }
}
