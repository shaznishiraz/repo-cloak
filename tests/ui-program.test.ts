import { Command } from 'commander';
import { expect, it, vi } from 'vitest';
import { addUiCommand } from '../src/ui-program.js';

it('passes the port, browser preference and global JSON flag to the dashboard command', async () => {
  const run = vi.fn(async () => {});
  const program = new Command().option('--json');
  addUiCommand(program, run);
  await program.parseAsync(['ui', '--port', '4321', '--no-open', '--json'], { from: 'user' });
  expect(run).toHaveBeenCalledWith(expect.any(Function), { port: 4321, open: false, json: true });
});
it('rejects invalid ports before starting a server', async () => {
  for (const port of ['0', '-1', '65536', '1.5', 'hello']) {
    const run = vi.fn(async () => {});
    const program = new Command();
    addUiCommand(program, run);
    await expect(program.parseAsync(['ui', '--port', port], { from: 'user' })).rejects.toThrow(
      'Port must be',
    );
    expect(run).not.toHaveBeenCalled();
  }
});
