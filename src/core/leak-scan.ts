/**
 * Heuristic search for proprietary names no rule knows about. A finding is a likely leftover, and
 * an empty result proves nothing. Findings can hold real names, so they belong on the local
 * dashboard only: never in the audit log, an agent response or a file in the cloak.
 */
import { detectSecretNames } from './secrets.js';

export type LeakKind = 'identity' | 'server' | 'domain' | 'email' | 'connection' | 'url' | 'secret';
export type LeakFinding = { path: string; name: string; kind: LeakKind };
/** `texts` are searched in order and reported under `path`: usually a cloaked path and its text. */
export type LeakDocument = { path: string; texts: string[] };
export type LeakIdentity = {
  /** Words that must appear next to each other, such as `acme health`. */
  terms: string[];
  domains: string[];
};
export type LeakLimits = {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  maxLineLength: number;
  maxFindings: number;
  maxMillis: number;
};
export type LeakScan = {
  findings: LeakFinding[];
  filesScanned: number;
  filesTotal: number;
  /** A limit was hit, so more could be there. */
  partial: boolean;
};

const defaultLimits: LeakLimits = {
  maxFiles: 2000,
  // Counted in UTF-16 characters: close enough for a bound, and cheap.
  maxBytes: 16 * 1024 * 1024,
  maxFileBytes: 256 * 1024,
  maxLineLength: 4000,
  maxFindings: 200,
  maxMillis: 1000,
};
const maxName = 80;
const maxMasks = 500;
/** Stands in for a replaced value. Cannot be part of a token, URL or address. */
const maskMark = '\u0001';

const words = (list: string) => new Set(list.split(' '));

/* Cloud suffixes are left out on purpose: `acme.database.windows.net` holds the customer's name. */
const publicHosts =
  'localhost localdomain example.com example.org example.net domain.com company.com yourcompany.com yourdomain.com mydomain.com ' +
  'github.com github.io githubusercontent.com gitlab.com bitbucket.org ' +
  'npmjs.org npmjs.com yarnpkg.com pypi.org pythonhosted.org rubygems.org nuget.org crates.io maven.org golang.org go.dev ' +
  'docker.com docker.io ghcr.io mcr.microsoft.com ' +
  'w3.org json-schema.org schema.org schemastore.org xml.org apache.org opensource.org creativecommons.org gnu.org ' +
  'mozilla.org mozilla.com nodejs.org python.org rust-lang.org typescriptlang.org php.net oracle.com ' +
  'microsoft.com apple.com google.com googleapis.com gstatic.com wikipedia.org stackoverflow.com ' +
  'jsdelivr.net unpkg.com cdnjs.com cloudflare.com shields.io socket.io ' +
  'react.dev reactjs.org vuejs.org angular.io eslint.org prettier.io vitest.dev jestjs.io tailwindcss.com semver.org keepachangelog.com';
const publicHostList = publicHosts.split(' ');
const reservedTlds = words('test invalid example localhost');
const publicMail = words(
  'gmail.com googlemail.com outlook.com hotmail.com live.com yahoo.com icloud.com me.com proton.me protonmail.com aol.com gmx.com',
);
const internalTlds = words('internal corp local lan intranet private');
const bareTlds = words('com net org io');
/** Dotted code, not names: `this.net`, `com.acme.internal`. */
const receivers = words(
  'this self cls ctx req res app config conf options opts props state data event err error window document module exports process console user users org file files path os sys util utils params args obj item node model server client com net io java javax kotlin',
);
const webSchemes = words('http https ws wss ftp sftp ssh git smb ldap ldaps s3 gs');
const dataSchemes = words(
  'postgres postgresql mysql mariadb mongodb mongodb+srv redis rediss amqp amqps sqlserver mssql oracle',
);
const roles = words(
  'sql db dbs srv svr server web app api host vm nas ftp smtp ldap bastion jump proxy gw lb mq dc ad',
);
const standaloneRoles = words('sql db dbs srv svr server web app host vm nas');
const liveEnvironments = words('prod prd production stg staging uat preprod');
const environments = new Set([...liveEnvironments, 'dev', 'test', 'qa']);
const genericWords = words(
  'api apis app apps web site service services server client core main test tests repo repos repository code data source sources src backend frontend mobile docs lib libs sdk tool tools project projects platform worktree worktrees workspace workspaces ' +
    'sample samples example examples demo health status config portal common shared utils internal private public personal work dev github gitlab bitbucket company clients customers home users tmp temp var folders',
);

const hostShape = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;
const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ipShape = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isPublicHost(host: string) {
  if (host === '.' || host === '(local)') return true;
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name.startsWith('127.') || name === '0.0.0.0') return true;
  if (reservedTlds.has(name.split('.').at(-1) ?? '')) return true;
  return publicHostList.some((item) => name === item || name.endsWith(`.${item}`));
}

/** `ch-prod-sql01`, `db01`, `acme-prod-db`, `app-uat-02`, but not `node-18` or `dev-server`. */
function isServerLike(token: string) {
  if (token.length > 63 || uuidShape.test(token)) return false;
  const segments = token.toLowerCase().split('-');
  if (segments.length > 6 || segments.some((segment) => !/^[a-z0-9]+$/.test(segment))) return false;
  const numbered = segments.map((segment) => /^([a-z]+)(\d+)$/.exec(segment));
  const isRole = (segment: string, index: number) =>
    roles.has(segment) || roles.has(numbered[index]?.[1] ?? '');
  const live = segments.some((segment) => liveEnvironments.has(segment));
  if (segments.length === 1) {
    const [, role = '', digits = ''] = numbered[0] ?? [];
    return standaloneRoles.has(role) && digits.length >= 2 && digits.length <= 3;
  }
  const paddedRole = numbered.some(
    (match) => match && roles.has(match[1] ?? '') && (match[2] ?? '').length >= 2,
  );
  if (paddedRole) return (numbered.at(-1) ?? null) !== null || segments.length > 2;
  if (live && segments.some(isRole)) return segments.length >= 3 || !!numbered.at(-1);
  // `x-uat-02`: an environment and a machine number, with something else to name it.
  return (
    segments.length >= 3 &&
    segments.some((segment) => environments.has(segment)) &&
    /^\d+$/.test(segments.at(-1) ?? '')
  );
}

function isDomainLike(token: string, authorDomains: Set<string>) {
  const lower = token.toLowerCase();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(lower) || token.length > 253) return false;
  if (authorDomains.has(lower) || [...authorDomains].some((item) => lower.endsWith(`.${item}`)))
    return true;
  // Hostnames come all lower case, all upper case, or capitalised at the start of a sentence.
  const firstCapital = token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  if (token !== lower && token !== token.toUpperCase() && token !== firstCapital) return false;
  const labels = lower.split('.');
  const tld = labels.at(-1) ?? '';
  if (receivers.has(labels[0] ?? '') || isPublicHost(lower)) return false;
  return internalTlds.has(tld) || bareTlds.has(tld);
}

/** `AcmeHealth-api` is `acme health api`. */
function splitWords(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The whole name and, for a repository, its first distinctive word: `acme` of `acme-portal`. */
function addName(terms: Set<string>, name: string, firstWord: boolean) {
  const parts = splitWords(name);
  const distinctive = parts.filter((word) => word.length >= 4 && !genericWords.has(word));
  const [first] = distinctive;
  if (!first) return;
  terms.add(parts.join(' '));
  if (parts.length > 1) terms.add(parts.join(''));
  if (firstWord) terms.add(first);
}

function remoteParts(remoteUrl: string) {
  const url = remoteUrl
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]*)(?::\d+)?\/(.*)$/i.exec(url) ??
    /^(?:[^/@]*@)?([^/:]+):(?!\/)(.*)$/.exec(url);
  if (match) return { host: match[1] ?? '', path: (match[2] ?? '').split('/') };
  return { host: '', path: url.split(/[\\/]/) }; // A remote that is a local folder.
}

/** Names that identify the source repository. Remote credentials are never kept. */
export function leakIdentity(source: {
  remoteUrl: string;
  paths: string[];
  authorEmails: string[];
}): LeakIdentity {
  const terms = new Set<string>();
  const domains = new Set<string>();
  const addDomain = (domain: string) => {
    const name = domain.toLowerCase();
    if (!name.includes('.') || isPublicHost(name) || publicMail.has(name) || ipShape.test(name))
      return;
    domains.add(name);
    // `git.contoso.se` is `contoso`; the label before a country or generic top-level domain.
    addName(terms, name.split('.').at(-2) ?? '', true);
  };
  const { host, path } = remoteParts(source.remoteUrl);
  addDomain(host);
  for (const part of path.slice(-2)) addName(terms, part, true);
  for (const full of source.paths) {
    const parts = full.split(/[\\/]/).filter(Boolean);
    const home = parts.findIndex((part) => /^(?:users|home)$/i.test(part));
    // The folder under Users or home is a username, which identifies a person, not this repo.
    const kept = home >= 0 ? parts.slice(home + 2) : parts;
    const segments = kept.slice(-3);
    for (const [index, segment] of segments.entries())
      addName(terms, segment, index === segments.length - 1);
  }
  for (const email of source.authorEmails) {
    const at = email.lastIndexOf('@');
    if (at > 0) addDomain(email.slice(at + 1).trim());
  }
  return { terms: [...terms], domains: [...domains] };
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function maskPattern(masks: string[]) {
  const usable = [...new Set(masks.filter((mask) => mask.length >= 3))]
    .sort((a, b) => b.length - a.length)
    .slice(0, maxMasks);
  return usable.length ? new RegExp(usable.map(escapeRegex).join('|'), 'gi') : null;
}

const urlPattern = /\b([a-z][a-z0-9+.-]{1,30}):\/\/([^\s'"`<>()\\,;]{1,500})/gi;
// After a word, colon or backslash it is an escaped Windows path or regex, not `\\\\server\\share`.
const uncPattern = /(?<![\w:\\])\\\\([a-z0-9][a-z0-9._-]{0,62})\\/gi;
const keyValuePattern =
  /\b(server|data source|host|hostname|addr|address)\s*=\s*([^;'"\s]{1,200})(?=[;\s])/gi;
const otherKeyPattern =
  /\b(?:database|dbname|initial catalog|uid|user id|username|password|pwd|port|integrated security|trusted_connection|encrypt)\s*=/i;
const emailPattern = /[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,8})/gi;
const tokenPattern = /[A-Za-z0-9][A-Za-z0-9._-]*/g;

function blank(line: string, start: number, length: number) {
  return line.slice(0, start) + ' '.repeat(length) + line.slice(start + length);
}

function createLineScanner(identity: LeakIdentity) {
  const authorDomains = new Set(identity.domains);
  const singles = new Set<string>();
  const phrases: string[] = [];
  const phraseStarts = new Set<string>();
  for (const term of identity.terms) {
    if (term.includes(' ')) {
      phrases.push(` ${term} `);
      phraseStarts.add(term.split(' ')[0] ?? '');
    } else singles.add(term);
  }
  const matchesIdentity = (token: string) => {
    const parts = splitWords(token);
    if (parts.some((word) => singles.has(word))) return true;
    if (!parts.some((word) => phraseStarts.has(word))) return false;
    const joined = ` ${parts.join(' ')} `;
    return phrases.some((phrase) => joined.includes(phrase));
  };

  return (original: string, report: (name: string, kind: LeakKind) => void) => {
    let line = original;

    for (const match of original.matchAll(urlPattern)) {
      const scheme = (match[1] ?? '').toLowerCase();
      const web = webSchemes.has(scheme);
      if (!web && !dataSchemes.has(scheme)) continue;
      const authority = (match[2] ?? '').split(/[/?#]/)[0] ?? '';
      const server = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '');
      if (!hostShape.test(server) || isPublicHost(server)) continue;
      const lower = server.toLowerCase();
      const fullName = server.includes('.') || isServerLike(server) || authorDomains.has(lower);
      // `s3://bucket` names a bucket, while `http://db:5432` is usually a local service name.
      if (!fullName && scheme !== 's3' && scheme !== 'gs') continue;
      report(`${scheme}://${server}`, web ? 'url' : 'connection');
      line = blank(line, match.index, match[0].length);
    }

    if (otherKeyPattern.test(line))
      for (const match of line.matchAll(keyValuePattern)) {
        const value = (match[2] ?? '')
          .replace(/^tcp:/i, '')
          .replace(/,\d+$/, '')
          .replace(/\\.*$/, '');
        if (!hostShape.test(value) && value !== '.' && value !== '(local)') continue;
        if (isPublicHost(value)) continue;
        report(`${match[1]}=${value}`, 'connection');
        line = blank(line, match.index, match[0].length);
      }

    for (const match of line.matchAll(uncPattern))
      // Short plain names here are usually escapes such as `"\\\\d\\\\w"`.
      if (/[\d.-]/.test(match[1] ?? '') && !isPublicHost(match[1] ?? ''))
        report(match[1] ?? '', 'server');

    for (const match of line.matchAll(emailPattern)) {
      const domain = (match[1] ?? '').toLowerCase();
      if (!/\.[a-z]{2,}$/.test(domain) || isPublicHost(domain)) continue;
      report(match[0], 'email');
      line = blank(line, match.index, match[0].length);
    }

    for (const match of line.matchAll(tokenPattern)) {
      const raw = match[0];
      // Right after a replaced value, a dot joins two parts of a name; it is not a suffix.
      const before = line[match.index - 2] === maskMark ? undefined : line[match.index - 1];
      const token = raw.replace(/[._-]+$/, '');
      if (!token) continue;
      // A leading dot is a suffix or property (`.env.local`), `#` a colour, `-` an option or a
      // name a replaced value has already covered.
      if (before !== '.' && before !== '#') {
        if (isDomainLike(token, authorDomains)) {
          report(token, 'domain');
          continue;
        }
        const covered = line[match.index - 2] === maskMark && line[match.index - 1] === '-';
        if (before !== '-' && !covered && raw === token && isServerLike(token)) {
          report(token, 'server');
          continue;
        }
      }
      if (matchesIdentity(token)) report(token, 'identity');
    }
  };
}

/** Bounded by files, bytes, line length, findings and time; hitting any limit sets `partial`. */
export function scanForLeaks(
  documents: LeakDocument[],
  options: {
    identity: LeakIdentity;
    /** Replaced values: they are what a cloak is meant to contain. */
    masks: string[];
    limits?: Partial<LeakLimits>;
    /** Without a clock, the time limit does not apply. */
    now?: () => number;
  },
): LeakScan {
  const limits = { ...defaultLimits, ...options.limits };
  const now = options.now ?? (() => 0);
  const deadline = now() + limits.maxMillis;
  const mask = maskPattern(options.masks);
  const scanLine = createLineScanner(options.identity);
  const findings: LeakFinding[] = [];
  let scanned = 0;
  let bytes = 0;
  let partial = false;

  for (const document of documents) {
    if (
      scanned >= limits.maxFiles ||
      bytes >= limits.maxBytes ||
      findings.length >= limits.maxFindings ||
      now() >= deadline
    ) {
      partial = true;
      break;
    }
    scanned++;
    const seen = new Set<string>();
    const report = (name: string, kind: LeakKind) => {
      const shown = name.slice(0, maxName);
      if (seen.has(shown)) return;
      seen.add(shown);
      if (findings.length >= limits.maxFindings) partial = true;
      else findings.push({ path: document.path, name: shown, kind });
    };
    for (const text of document.texts) {
      const room = Math.min(limits.maxFileBytes, limits.maxBytes - bytes);
      if (text.length > room) partial = true;
      const kept = text.slice(0, room);
      bytes += kept.length;
      const clean = mask ? kept.replace(mask, (found) => maskMark.repeat(found.length)) : kept;
      // Secret rules are opt-in, so warn about what none caught. Names the detector, not the value.
      for (const name of detectSecretNames(clean)) report(name, 'secret');
      for (const line of clean.split('\n')) {
        if (line.length > limits.maxLineLength) partial = true;
        scanLine(line.slice(0, limits.maxLineLength), report);
      }
    }
  }
  return { findings, filesScanned: scanned, filesTotal: documents.length, partial };
}
