import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dashboard } from '../../application/dashboard.js';
import { hashJson } from '../../core/hash.js';
import { compilePatterns } from '../../core/patterns.js';
import type { SavedProfile } from '../../core/profiles.js';
import { createReplacer } from '../../core/replacer.js';
import { entropy, secretDetectors } from '../../core/secrets.js';
import type { ProfileSuggestion } from '../../web/api/contracts.js';
import { runGit, runGitBytes } from '../git.js';

export function detectSecret(text: string): string | undefined {
  for (const detector of secretDetectors) {
    const flags = detector.pattern.flags.includes('g')
      ? detector.pattern.flags
      : `${detector.pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(detector.pattern.source, flags))) {
      const value = match.groups?.secret ?? match[0];
      if (!detector.entropy || entropy(value) >= detector.entropy) return detector.name;
    }
  }
  return undefined;
}

const skipped = compilePatterns([
  'node_modules/',
  'dist/',
  'build/',
  'vendor/',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.min.js',
  '*.map',
]);
const scanLimits = { files: 3000, fileBytes: 256 * 1024, totalBytes: 24 * 1024 * 1024 };

/** Regular text files only. A tracked symlink could otherwise read outside the repository. */
async function* scanFiles(root: string, excluded: (path: string) => boolean) {
  const listing = await runGitBytes(root, [
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
  ]);
  let files = 0;
  let total = 0;
  for (const path of listing.toString('utf8').split('\0')) {
    if (!path || skipped(path) || excluded(path)) continue;
    if (files >= scanLimits.files || total >= scanLimits.totalBytes) return;
    const full = join(root, path);
    const info = await lstat(full).catch(() => undefined);
    if (!info?.isFile() || info.size > scanLimits.fileBytes) continue;
    const bytes = await readFile(full).catch(() => undefined);
    if (!bytes || bytes.includes(0)) continue;
    files += 1;
    total += bytes.length;
    yield bytes.toString('utf8');
  }
}

type Cached<T> = { at: number; value: T };
const scanCache = new Map<string, Cached<unknown>>();
async function cachedScan<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const found = scanCache.get(key);
  if (found && Date.now() - found.at < 60_000) return found.value as T;
  const value = await compute();
  if (scanCache.size >= 32) scanCache.clear();
  scanCache.set(key, { at: Date.now(), value });
  return value;
}
async function headOf(root: string) {
  return (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
}
async function repoPath(dashboard: Dashboard, id: string) {
  const repo = (await dashboard.overview()).find((item) => item.id === id);
  return repo && !repo.missing ? repo.path : undefined;
}

async function excludedBy(dashboard: Dashboard, id: string, profiles: SavedProfile[]) {
  const [security, repo] = await Promise.all([
    dashboard.settings.effective(),
    dashboard.sync.exclusions(id),
  ]);
  return compilePatterns([
    ...security.lockedExclusions,
    ...repo.patterns,
    ...profiles.flatMap((saved) => saved.profile.exclude ?? []),
  ]);
}

/** Replacements per rule id across the repo's text files, as a pull would apply them. */
export async function countHits(dashboard: Dashboard, saved: SavedProfile, id: string) {
  const root = await repoPath(dashboard, id);
  if (!root) return {};
  const key = `hits:${root}:${await headOf(root)}:${hashJson(saved.profile)}`;
  return cachedScan(key, async () => {
    const hits: Record<string, number> = {};
    const replacer = createReplacer(saved.profile.rules);
    for await (const text of scanFiles(root, await excludedBy(dashboard, id, [saved]))) {
      try {
        for (const match of replacer.anonymize(text).preview)
          if (match.status === 'replaced') hits[match.ruleId] = (hits[match.ruleId] ?? 0) + 1;
      } catch {
        // A pull would stop on this file and report it. Hits are only an estimate.
      }
    }
    return hits;
  });
}

const commonHosts = new Set([
  'github.com',
  'gitlab.com',
  'npmjs.com',
  'www.npmjs.com',
  'registry.npmjs.org',
  'example.com',
  'www.example.com',
  'schema.org',
  'www.w3.org',
  'w3.org',
  'nodejs.org',
  'stackoverflow.com',
  'google.com',
  'www.google.com',
  'microsoft.com',
  'docs.microsoft.com',
  'mozilla.org',
  'developer.mozilla.org',
  'opensource.org',
  'json-schema.org',
  'unpkg.com',
]);
const commonWords = new Set(
  'abstract action api app application array async auth base buffer build builder button cache card channel class client code column command component config connection console container content context control controller core create custom data database date debug default delete detail dialog document dom error event exception factory field file filter form format function get group handler header helper home http id image index info input invalid item json key layout link list load local log logger login main manager map menu message method mock model module name node number object option order output page panel param parent password path plugin post project promise property provider public query read record request resource response result role root route router rule run save schema screen script search select send server service session set settings source state status store string style system tab table task test text theme time token tool type update url user util value view web window work write'
    .split(' ')
    .map((word) => word),
);
const commonAcronyms = new Set(
  'API APIS CLI CPU CSS CSV DOM DTO EOF ESM FAQ GET GIF GPU GUI HEAD HTML HTTP HTTPS IDE JPEG JSON JWT LICENSE MIME MIT NOTE NPM OAUTH ORM PATCH PDF PNG POST PUT RAM README REST SDK SHA SQL SSH SSL SVG TCP TLS TODO FIXME TSX UDP UI URI URL USB UTC UTF UUID WARN XML YAML ZIP AND THE NOT FOR NULL TRUE FALSE'.split(
    ' ',
  ),
);

/** Names worth a rule: found by shape, ranked by hits, minus what rules already cover. */
export function collectSuggestions(
  texts: Iterable<string>,
  covered: readonly string[],
): ProfileSuggestion[] {
  const hosts = new Map<string, number>();
  const prefixes = new Map<string, { hits: number; tokens: Set<string> }>();
  const acronyms = new Map<string, number>();
  const add = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const text of texts) {
    for (const [host] of text.matchAll(
      /\b(?:[a-z0-9][a-z0-9-]*\.)+(?:com|net|org|io|internal|local|corp|lan|cloud)\b/g,
    ))
      if (!commonHosts.has(host)) add(hosts, host);
    for (const [host] of text.matchAll(/\b[a-z]{2,}-(?:prod|staging|dev|qa|uat)-[a-z0-9-]+\b/g))
      add(hosts, host);
    for (const [token, prefix = ''] of text.matchAll(/\b([A-Z][a-z]{2,})(?:[A-Z][a-z0-9]+)+\b/g)) {
      if (commonWords.has(prefix.toLowerCase())) continue;
      const entry = prefixes.get(prefix) ?? { hits: 0, tokens: new Set<string>() };
      entry.hits += 1;
      entry.tokens.add(token);
      prefixes.set(prefix, entry);
    }
    for (const [word] of text.matchAll(/\b[A-Z]{3,6}\b/g))
      if (!commonAcronyms.has(word)) add(acronyms, word);
  }
  const known = covered.map((name) => name.toLowerCase());
  const isCovered = (text: string) => {
    const lower = text.toLowerCase();
    return known.some((name) => lower.includes(name) || name.includes(lower));
  };
  const suggestions: ProfileSuggestion[] = [
    ...[...hosts].map(([text, hits]) => ({ text, reason: 'host', hits })),
    ...[...prefixes]
      .filter(([, entry]) => entry.tokens.size >= 2)
      .map(([text, entry]) => ({ text, reason: 'PascalCase prefix', hits: entry.hits })),
    ...[...acronyms]
      .filter(([, hits]) => hits >= 3)
      .map(([text, hits]) => ({ text, reason: 'business acronym', hits })),
  ];
  return suggestions
    .filter((item) => !isCovered(item.text) && !detectSecret(item.text))
    .sort((a, b) => b.hits - a.hits || a.text.localeCompare(b.text))
    .slice(0, 8);
}

/** Names worth a rule across the repository, excluding what the profiles already cover. */
export async function scanSuggestions(
  dashboard: Dashboard,
  id: string,
  covered: readonly string[],
): Promise<ProfileSuggestion[]> {
  const root = await repoPath(dashboard, id);
  if (!root) return [];
  const key = `suggest:${root}:${await headOf(root)}:${hashJson(covered)}`;
  return cachedScan(key, async () => {
    const texts: string[] = [];
    for await (const text of scanFiles(root, await excludedBy(dashboard, id, []))) texts.push(text);
    return collectSuggestions(texts, covered);
  });
}
