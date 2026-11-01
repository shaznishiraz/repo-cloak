import { defineConfig } from 'tsup';
import { buildWeb } from './scripts/build-ui.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { documentKinds, jsonSchema } from './src/core/schemas.js';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  noExternal: ['lodash-es'],
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    await buildWeb('dist/web');
    await mkdir('schemas', { recursive: true });
    await Promise.all(
      documentKinds.map((kind) =>
        writeFile(`schemas/${kind}.schema.json`, `${JSON.stringify(jsonSchema(kind), null, 2)}\n`),
      ),
    );
  },
});
