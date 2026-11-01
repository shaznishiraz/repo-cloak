import { describe, expect, it } from 'vitest';
import { leakIdentity, scanForLeaks } from '../../src/core/leak-scan.js';
import type { LeakIdentity, LeakKind } from '../../src/core/leak-scan.js';

const noIdentity: LeakIdentity = { terms: [], domains: [] };
function scan(text: string, identity = noIdentity, masks: string[] = []) {
  return scanForLeaks([{ path: 'a.ts', texts: [text] }], { identity, masks }).findings;
}
const names = (text: string, identity = noIdentity, masks: string[] = []) =>
  scan(text, identity, masks).map((finding) => finding.name);

describe('hits', () => {
  it.each<[string, string, LeakKind]>([
    ['const host = "ch-prod-sql01";', 'ch-prod-sql01', 'server'],
    ['HOST=CH-PROD-SQL01', 'CH-PROD-SQL01', 'server'],
    ['ssh db01', 'db01', 'server'],
    ['acme-prod-db', 'acme-prod-db', 'server'],
    ['deploy to app-uat-02 tonight', 'app-uat-02', 'server'],
    ['billing-sql01', 'billing-sql01', 'server'],
    ['\\\\fileserver01\\share', 'fileserver01', 'server'],
    ['see wiki.corp and vault.acme.internal', 'wiki.corp', 'domain'],
    ['see vault.acme.internal', 'vault.acme.internal', 'domain'],
    ['DC01.CORP.ACME.LOCAL', 'DC01.CORP.ACME.LOCAL', 'domain'],
    ['fetch from acme-health.com today', 'acme-health.com', 'domain'],
    ['Visit Acme.com', 'Acme.com', 'domain'],
    ['mail jane.doe@acme-health.se now', 'jane.doe@acme-health.se', 'email'],
    ['fetch("https://portal.acme.se/login?x=1")', 'https://portal.acme.se', 'url'],
    ['git clone ssh://git@git.acme.se:22/team/app.git', 'ssh://git.acme.se', 'url'],
    ['http://ch-prod-sql01:8080/health', 'http://ch-prod-sql01', 'url'],
    ['http://10.20.30.40/admin', 'http://10.20.30.40', 'url'],
    ['s3://acme-private-bucket/key', 's3://acme-private-bucket', 'url'],
    ['postgres://db.acme.se:5432/claims', 'postgres://db.acme.se', 'connection'],
    ['jdbc:sqlserver://ch-prod-sql01:1433;database=x', 'sqlserver://ch-prod-sql01', 'connection'],
    ['Server=sql7;Database=Claims;User Id=sa;', 'Server=sql7', 'connection'],
    ['Data Source=tcp:hq-box,1433;Initial Catalog=Claims', 'Data Source=hq-box', 'connection'],
    ['host=pgmain port=5432 dbname=claims', 'host=pgmain', 'connection'],
  ])('flags %s', (text, name, kind) => {
    expect(scan(text)).toContainEqual({ path: 'a.ts', name, kind });
  });

  it('never repeats credentials, paths or other fields from what it reports', () => {
    const shown = names(
      [
        'postgres://admin:hunter2@db.acme.se/claims?token=abc',
        'Server=sql7;Database=Claims;Password=hunter3;',
        'https://bob:hunter4@portal.acme.se/secret-path?key=hunter5',
      ].join('\n'),
    ).join(' ');
    expect(shown).toContain('db.acme.se');
    expect(shown).not.toMatch(/hunter|admin|bob|claims|secret-path|token|Database/i);
  });

  it('reports one name once per file, and again for another file', () => {
    const { findings } = scanForLeaks(
      [
        { path: 'a.ts', texts: ['db01 db01', 'db01'] },
        { path: 'b.ts', texts: ['db01'] },
      ],
      { identity: noIdentity, masks: [] },
    );
    expect(findings.map((finding) => finding.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('caps a very long name', () => {
    const [name] = names(`${'a'.repeat(120)}.acme.internal`);
    expect(name?.length).toBeLessThanOrEqual(80);
  });
});

describe('false positives', () => {
  it.each([
    'http://localhost:3000/path',
    'http://127.0.0.1:8080 and http://0.0.0.0:80 and http://[::1]:80/',
    'https://example.com/a https://www.example.org/b http://foo.example.net',
    'http://app.test/x http://thing.invalid/ http://site.localhost',
    'https://registry.npmjs.org/react/-/react-18.tgz',
    'https://www.npmjs.com/package/x https://pypi.org/simple https://rubygems.org',
    'https://github.com/facebook/react https://raw.githubusercontent.com/a/b/c',
    'git@github.com:facebook/react.git',
    'xmlns="http://www.w3.org/2000/svg" https://json-schema.org/draft/2020-12/schema',
    'https://opensource.org/licenses/MIT https://developer.mozilla.org/en-US/docs',
    'dev@example.com admin@foo.example.org 123+a@users.noreply.github.com',
    'user@domain.com you@company.com',
    '"react": "npm:react@18.2.0" @babel/core@7.0.0 pkg@v1.2.3 image@sha256:abc',
    'this.net self.org user.org ctx.local this.internal options.local',
    'cat .env.local && ./foo.local.json settings.local.json',
    'import com.acme.internal.Foo; org.apache.commons.net',
    'console.log(index.js); foo.bar.baz(); a.b.c.d; System.Net.Http; socket.io',
    'node-18 ubuntu-22 windows-2022 mysql-8 postgres-15 redis-7 python3 mysql8 pg14 node18 md5',
    'dev-server test-server api-test web-dev prod-db us-east-1 btn-primary web-01 app2 db2 web3',
    'PROD_DB_HOST prod_sql01 test-db1 --web-prod-01 color: #db01;',
    '550e8400-e29b-41d4-db01-446655440000 sha256 utf8 h264 s3 ec2',
    'version 10.2.3.4 and 1.2.3 and 192.168.1.1',
    'http://db:5432 http://backend:3000 redis://cache:6379 mongodb://mongo/db',
    'http://${HOST}/x https://{{ domain }}/y postgres://<host>/db http://%s/',
    'Server=${DB_HOST};Database=x; Server=localhost;Database=x; Server=.;Database=x;',
    'Server=(local);Database=x; Data Source=127.0.0.1;Initial Catalog=y;',
    'host=value; const server = 1; server=foo',
    String.raw`"C:\\Users\\foo\\bar" "\\d+\\w+\\" "\\name\\"`,
    'file:///usr/local/bin data:text/plain,hello mailto: ftp:',
    'Copyright (c) Foo Bar. All rights reserved. The quick brown fox.',
  ])('does not flag %s', (text) => {
    expect(names(text)).toEqual([]);
  });

  it('ignores replaced values whatever their case', () => {
    const masks = ['Northwind', 'northwind-sql01'];
    expect(names('Northwind-prod-sql01 northwind-sql01', noIdentity, masks)).toEqual([]);
    expect(names('NORTHWIND-prod-sql01', noIdentity, masks)).toEqual([]);
    expect(names('https://northwind.com/x a@Northwind.com', noIdentity, masks)).toEqual([]);
  });

  it('still reports what a replaced value did not cover', () => {
    expect(names('foo.Zed.acme.com', noIdentity, ['Zed'])).toEqual(['acme.com']);
  });

  it('ignores replacements too short to mean anything', () => {
    expect(names('ab-prod-sql01', noIdentity, ['ab'])).toEqual(['ab-prod-sql01']);
  });
});

describe('identity', () => {
  const identity = leakIdentity({
    remoteUrl: 'https://user:hunter2@git.contoso.se/fabrikam/acme-health-api.git',
    paths: ['/Users/janedoe/clients/litware/acme-health-api'],
    authorEmails: [
      'jane@adatum-corp.se',
      'bob@gmail.com',
      'ci@example.com',
      '1+x@users.noreply.github.com',
      'not an email',
    ],
  });

  it('takes org, repo, path segments and private author and remote domains', () => {
    expect(names('FabrikamClient')).toEqual([]);
    expect(names('FabrikamClient', identity)).toEqual(['FabrikamClient']);
    expect(names('const x = "fabrikam";', identity)).toEqual(['fabrikam']);
    expect(names('acme_service', identity)).toEqual(['acme_service']);
    expect(names('AcmeHealthApi acme-health-api', identity)).toEqual([
      'AcmeHealthApi',
      'acme-health-api',
    ]);
    expect(names('litwareConfig', identity)).toEqual(['litwareConfig']);
    expect(names('adatum-corp', identity)).toEqual(['adatum-corp']);
    expect(names('contoso', identity)).toEqual(['contoso']);
  });

  it('finds an author domain the bare-domain rule would not', () => {
    expect(scan('see adatum-corp.se', identity)).toContainEqual({
      path: 'a.ts',
      name: 'adatum-corp.se',
      kind: 'domain',
    });
  });

  it('flags an org name inside an otherwise public URL', () => {
    expect(names('https://github.com/fabrikam/tools', identity)).toEqual(['fabrikam']);
  });

  it('never keeps credentials, the username or public hosts as terms', () => {
    const terms = JSON.stringify(identity);
    expect(terms).not.toContain('hunter2');
    expect(terms).not.toContain('janedoe');
    expect(terms).not.toContain('gmail');
    expect(terms).not.toContain('example');
    expect(terms).not.toContain('noreply');
    expect(terms).not.toContain('github');
  });

  it('does not flag generic or partial words', () => {
    expect(
      names('health check api service macmeal fabrikams litwares /healthz getHealth', identity),
    ).toEqual([]);
  });

  it('does not flag a replaced identity word', () => {
    expect(names('fabrikam', identity, ['fabrikam'])).toEqual([]);
  });

  it.each([
    'git@git.contoso.se:fabrikam/acme-health-api.git',
    'ssh://git@git.contoso.se:22/fabrikam/acme-health-api',
    'https://git.contoso.se/fabrikam/acme-health-api/',
    'git.contoso.se:fabrikam/acme-health-api',
  ])('parses remote %s', (remoteUrl) => {
    const parsed = leakIdentity({ remoteUrl, paths: [], authorEmails: [] });
    expect(names('fabrikam', parsed)).toEqual(['fabrikam']);
    expect(names('acme', parsed)).toEqual(['acme']);
    expect(parsed.domains).toContain('git.contoso.se');
  });

  it('copes with nothing known, and drops repository names with no distinctive word', () => {
    expect(leakIdentity({ remoteUrl: '', paths: [], authorEmails: [] })).toEqual({
      terms: [],
      domains: [],
    });
    const generic = leakIdentity({
      remoteUrl: 'https://github.com/my/app',
      paths: ['/home/someone/projects/web-api', 'C:\\Users\\someone\\repos\\source'],
      authorEmails: [],
    });
    expect(generic).toEqual({ terms: [], domains: [] });
  });
});

describe('limits', () => {
  const options = { identity: noIdentity, masks: [] };

  it('reports a clean full scan as not partial, with its coverage', () => {
    expect(scanForLeaks([{ path: 'a.ts', texts: ['nothing'] }], options)).toEqual({
      findings: [],
      filesScanned: 1,
      filesTotal: 1,
      partial: false,
    });
  });

  it('stops at the file limit', () => {
    const documents = ['a', 'b', 'c'].map((path) => ({ path, texts: ['db01'] }));
    const result = scanForLeaks(documents, { ...options, limits: { maxFiles: 2 } });
    expect(result).toMatchObject({ filesScanned: 2, filesTotal: 3, partial: true });
    expect(result.findings).toHaveLength(2);
  });

  it('reads only the start of a large file', () => {
    const text = `db01\n${'x'.repeat(100)}\nweb01`;
    const result = scanForLeaks([{ path: 'a', texts: [text] }], {
      ...options,
      limits: { maxFileBytes: 20 },
    });
    expect(result.findings.map((finding) => finding.name)).toEqual(['db01']);
    expect(result.partial).toBe(true);
  });

  it('stops at the total byte limit', () => {
    const documents = ['a', 'b', 'c'].map((path) => ({ path, texts: ['db01'.padEnd(10)] }));
    const result = scanForLeaks(documents, { ...options, limits: { maxBytes: 15 } });
    expect(result.filesScanned).toBe(2);
    expect(result.partial).toBe(true);
  });

  it('reads only the start of a very long line, such as a minified bundle', () => {
    const result = scanForLeaks([{ path: 'a', texts: [`db01 ${'x '.repeat(50)} web01`] }], {
      ...options,
      limits: { maxLineLength: 20 },
    });
    expect(result.findings.map((finding) => finding.name)).toEqual(['db01']);
    expect(result.partial).toBe(true);
  });

  it('stops at the finding limit', () => {
    const text = Array.from({ length: 50 }, (_, index) => `host${index + 10}-prod-sql01`).join(' ');
    const result = scanForLeaks(
      [
        { path: 'a', texts: [text] },
        { path: 'b', texts: ['db01'] },
      ],
      {
        ...options,
        limits: { maxFindings: 5 },
      },
    );
    expect(result.findings).toHaveLength(5);
    expect(result.partial).toBe(true);
  });

  it('stops when time runs out', () => {
    let clock = 0;
    const documents = ['a', 'b', 'c'].map((path) => ({ path, texts: ['db01'] }));
    const result = scanForLeaks(documents, {
      ...options,
      limits: { maxMillis: 100 },
      now: () => (clock += 60),
    });
    expect(result.filesScanned).toBeLessThan(3);
    expect(result.partial).toBe(true);
  });

  it('stays fast on input built to make a regex backtrack', () => {
    const evil = ['a.'.repeat(100_000), 'a-'.repeat(100_000), `${'a'.repeat(200_000)}@`].join('\n');
    const started = performance.now();
    scanForLeaks([{ path: 'a', texts: [evil] }], options);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
