import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'tsup';
import { minify } from 'terser';

/** Reuse the CLI's build tool to keep shipped browser assets small. */
export async function buildUi(destination: string) {
  const source = resolve('src/ui');
  await mkdir(destination, { recursive: true });
  const html = await readFile(join(source, 'index.html'), 'utf8');
  await Promise.all([
    copyFile(join(source, 'favicon.svg'), join(destination, 'favicon.svg')),
    copyFile(join(source, 'favicon.ico'), join(destination, 'favicon.ico')),
    writeFile(
      join(destination, 'index.html'),
      html
        .replace(/>\s+</g, '><')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    ),
    build({
      config: false,
      entry: [join(source, 'app.js'), join(source, 'app.css')],
      outDir: destination,
      format: ['esm'],
      platform: 'browser',
      target: 'es2022',
      clean: false,
      minify: true,
      silent: true,
    }),
  ]);
  // A final compression pass keeps the richer UI within its shipped asset budget.
  const script = join(destination, 'app.js');
  const result = await minify(await readFile(script, 'utf8'), {
    module: true,
    compress: { passes: 2 },
  });
  if (!result.code) throw new Error('UI compression produced no JavaScript');
  await writeFile(script, result.code);
}

/** Bundles the rebuilt dashboard; Preact and signals are inlined, so nothing ships as a dependency. */
export async function buildWeb(destination: string) {
  const source = resolve('src/web');
  await mkdir(destination, { recursive: true });
  const html = await readFile(join(source, 'index.html'), 'utf8');
  await Promise.all([
    copyFile(join(source, 'favicon.svg'), join(destination, 'favicon.svg')),
    copyFile(join(source, 'favicon.ico'), join(destination, 'favicon.ico')),
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
