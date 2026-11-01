import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { supplyChainReport } from '../../scripts/supply-chain.js';

const lock = {
  packages: {
    '': { version: '1.0.0' },
    'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' },
    'node_modules/b': { version: '2.0.0', integrity: 'sha512-b', dev: true },
    'node_modules/c': { version: '3.0.0', integrity: 'sha512-c', devOptional: true },
    'node_modules/preact': { version: '11.1.1', integrity: 'sha512-p', dev: true },
    'node_modules/@preact/signals': { version: '2.0.0', integrity: 'sha512-s', dev: true },
  },
};
const pkg = {
  version: '2.0.0',
  dependencies: { a: '1.0.0' },
  devDependencies: { b: '2.0.0', preact: '11.1.1' },
};

it('counts production packages and reads the install-script setting', () => {
  expect(supplyChainReport(pkg, lock, 'ignore-scripts=true\n')).toEqual({
    version: '2.0.0',
    directDependencies: 1,
    productionPackages: 1,
    installScriptsAllowed: false,
    pinned: true,
    integrityHashes: true,
    bundledBrowserPackages: ['preact@11.1.1', '@preact/signals@2.0.0'],
  });
  expect(supplyChainReport(pkg, lock, '').installScriptsAllowed).toBe(true);
});

it('notices floating versions and missing integrity hashes', () => {
  const floating = { ...pkg, dependencies: { a: '^1.0.0' } };
  expect(supplyChainReport(floating, lock, '').pinned).toBe(false);
  const missing = { packages: { ...lock.packages, 'node_modules/d': { version: '1.0.0' } } };
  expect(supplyChainReport(pkg, missing, '').integrityHashes).toBe(false);
});

it('the repo itself pins every version and disables install scripts', () => {
  const root = JSON.parse(readFileSync('package.json', 'utf8')) as typeof pkg;
  const report = supplyChainReport(
    root,
    JSON.parse(readFileSync('package-lock.json', 'utf8')) as typeof lock,
    readFileSync('.npmrc', 'utf8'),
  );
  expect(report).toMatchObject({
    pinned: true,
    installScriptsAllowed: false,
    integrityHashes: true,
  });
  expect(root.dependencies).not.toHaveProperty(['@modelcontextprotocol/sdk']);
  expect(root.devDependencies).not.toHaveProperty(['@modelcontextprotocol/sdk']);
  expect(root.devDependencies).toHaveProperty(['preact']);
  expect(root.dependencies).not.toHaveProperty(['preact']);
  expect(root.dependencies).not.toHaveProperty(['@preact/signals']);
});
