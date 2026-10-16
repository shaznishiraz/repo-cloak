import { describe, expect, it } from 'vitest';
import { createProgram } from '../src/program.js';

describe('schema command', () => {
  it.each(['profile', 'repo', 'manifest', 'config'])(
    'prints valid JSON Schema for %s',
    async (kind) => {
      let output = '';
      const program = createProgram()
        .configureOutput({
          writeOut: (value) => {
            output += value;
          },
        })
        .exitOverride();
      await program.parseAsync(['schema', kind], { from: 'user' });
      const schema = JSON.parse(output) as {
        $schema: string;
        properties: { kind: { const: string } };
      };
      expect(schema.$schema).toContain('json-schema.org');
      expect(schema.properties.kind.const).toBe(kind);
    },
  );
  it('reports unsupported kinds', async () => {
    const program = createProgram()
      .configureOutput({ writeErr: () => {} })
      .exitOverride();
    for (const command of program.commands)
      command.configureOutput({ writeErr: () => {} }).exitOverride();
    await expect(program.parseAsync(['schema', 'unknown'], { from: 'user' })).rejects.toThrow(
      /profile.*repo.*manifest.*config/,
    );
  });
});
