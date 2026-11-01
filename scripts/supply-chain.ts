import { readFile } from 'node:fs/promises';
import type { SupplyChainReport } from '../src/web/api/contracts.js';

type PackageJson = {
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
type Lockfile = {
  packages: Record<
    string,
    {
      version?: string;
      dev?: boolean;
      devOptional?: boolean;
      link?: boolean;
      integrity?: string;
    }
  >;
};
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const browserPackages = ['preact', '@preact/signals'];

/** Computes the numbers Settings shows from the files that decide them, at build time. */
export function supplyChainReport(
  pkg: PackageJson,
  lock: Lockfile,
  npmrc: string,
): SupplyChainReport {
  const installed = Object.entries(lock.packages).filter(([path, entry]) => path && !entry.link);
  const production = installed.filter(([, entry]) => !entry.dev && !entry.devOptional);
  const declared = { ...pkg.dependencies, ...pkg.devDependencies };
  return {
    version: pkg.version,
    directDependencies: Object.keys(pkg.dependencies ?? {}).length,
    productionPackages: production.length,
    installScriptsAllowed: !/^\s*ignore-scripts\s*=\s*true\s*$/m.test(npmrc),
    pinned: Object.values(declared).every((version) => exactVersion.test(version)),
    integrityHashes: installed.every(([, entry]) => !!entry.integrity),
    bundledBrowserPackages: browserPackages.map(
      (name) => `${name}@${lock.packages[`node_modules/${name}`]?.version ?? 'unknown'}`,
    ),
  };
}

export async function readSupplyChainReport(): Promise<SupplyChainReport> {
  const [pkg, lock, npmrc] = await Promise.all([
    readFile('package.json', 'utf8'),
    readFile('package-lock.json', 'utf8'),
    readFile('.npmrc', 'utf8'),
  ]);
  return supplyChainReport(JSON.parse(pkg) as PackageJson, JSON.parse(lock) as Lockfile, npmrc);
}
