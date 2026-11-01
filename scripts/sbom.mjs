// `npm sbom --omit dev` misses dev dependencies bundled into dist/web, so add them back.
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { readFileSync } from 'node:fs';

const bundled = ['preact', '@preact/signals', '@preact/signals-core'];
const sbom = JSON.parse(
  execFileSync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  }),
);
const { packages } = JSON.parse(readFileSync('package-lock.json', 'utf8'));
for (const name of bundled) {
  const entry = packages[`node_modules/${name}`];
  if (!entry) throw new Error(`${name} is not in package-lock.json`);
  const purl = `pkg:npm/${name.replace('@', '%40')}@${entry.version}`;
  if (sbom.components.some((component) => component.purl === purl)) continue;
  sbom.components.push({
    type: 'library',
    'bom-ref': `${name}@${entry.version}`,
    name,
    version: entry.version,
    purl,
    scope: 'required',
    licenses: entry.license ? [{ license: { id: entry.license } }] : undefined,
    properties: [{ name: 'repo-cloak:bundled', value: 'dist/web' }],
  });
}
process.stdout.write(`${JSON.stringify(sbom, null, 2)}\n`);
