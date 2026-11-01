import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'tsup';
import { readSupplyChainReport } from './supply-chain.js';

/** Bundles the dashboard; Preact and signals are inlined, so nothing ships as a dependency. */
export async function buildWeb(destination: string) {
  const source = resolve('src/web');
  await mkdir(destination, { recursive: true });
  const html = await readFile(join(source, 'index.html'), 'utf8');
  await Promise.all([
    copyFile(join(source, 'favicon.svg'), join(destination, 'favicon.svg')),
    copyFile(join(source, 'favicon.ico'), join(destination, 'favicon.ico')),
    writeFile(
      join(destination, 'supply-chain.json'),
      `${JSON.stringify(await readSupplyChainReport(), null, 2)}\n`,
    ),
    writeFile(
      join(destination, 'index.html'),
      html
        .replace(/>\s+</g, '><')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    ),
    build({
      config: false,
      entry: { app: join(source, 'main.tsx') },
      outDir: destination,
      format: ['esm'],
      platform: 'browser',
      target: 'es2022',
      tsconfig: join(source, 'tsconfig.json'),
      outExtension: () => ({ js: '.js' }),
      clean: false,
      minify: true,
      silent: true,
    }),
  ]);
}
