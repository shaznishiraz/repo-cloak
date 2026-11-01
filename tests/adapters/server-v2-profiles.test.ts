import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runGit } from '../../src/adapters/git.js';
import { collectSuggestions } from '../../src/adapters/server-v2/profile-scan.js';
import { documentProblems } from '../../src/adapters/server-v2/profiles.js';
import type { ProblemView, ProfileDetailView } from '../../src/adapters/server-v2/profiles.js';
import { createDashboardServer } from '../../src/adapters/server.js';
import { createStore } from '../../src/adapters/store.js';
import { createDashboard } from '../../src/application/dashboard.js';
import { secretDetectors } from '../../src/core/secrets.js';
import type {
  ProfileListItem,
  ProfileSuggestion,
  ProfileTestResult,
} from '../../src/web/api/contracts.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const doc = (extra: Record<string, unknown> = {}) => ({
  kind: 'profile',
  schemaVersion: 1,
  name: 'names',
  rules: [{ id: 'company', type: 'literal', match: 'Contoso', replace: 'Northwind' }],
  ...extra,
});
// Built at runtime so no secret-shaped literal lives in the repository.
const fakeToken = `ghp_${'a1B2c3D4e5'.repeat(3)}a1B2c3`;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cloak profiles v2 ')));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, 'source');
  await mkdir(source);
  await runGit(source, ['init', '-b', 'main']);
  const store = createStore(join(root, 'store'));
  const dashboard = createDashboard(store, source);
  const server = createDashboardServer(dashboard, 'test-token', resolve('src/web'));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}`;
  async function call(method: string, path: string, body?: unknown, token = 'test-token') {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as never };
  }
  const repoId = (await dashboard.context()).repoId as string;
  return { root, source, store, dashboard, call, repoId, base };
}
const global = { kind: 'global' };

it('creates, lists, reads, updates and deletes a profile', async () => {
  const { call, repoId } = await fixture();
  const created = await call('POST', '/api/v2/profiles', { scope: global, document: doc() });
  expect(created.status).toBe(200);
  const saved = created.json as ProfileDetailView;
  expect(saved.id).toMatch(/^pf_/);

  const repoProfile = await call('POST', '/api/v2/profiles', {
    scope: { kind: 'repo', repoId },
    document: doc({
      name: 'repo-only',
      rules: [{ id: 'r', type: 'literal', match: 'Fabrikam', replace: 'Tailspin' }],
      exclude: ['deploy/'],
    }),
  });
  const list = await call('GET', `/api/v2/profiles?repo=${repoId}`);
  const items = (list.json as { profiles: ProfileListItem[] }).profiles;
  expect(
    items.map((item) => [item.name, item.scope.kind, item.ruleCount, item.exclusionCount]),
  ).toEqual([
    ['names', 'global', 1, 0],
    ['repo-only', 'repo', 1, 1],
  ]);
  const globalOnly = await call('GET', '/api/v2/profiles');
  expect((globalOnly.json as { profiles: unknown[] }).profiles).toHaveLength(1);

  const read = (await call('GET', `/api/v2/profiles/${saved.id}`)).json as ProfileDetailView;
  expect(read.revision).toBe(saved.revision);
  expect(read.document).toMatchObject({ name: 'names' });

  const updated = await call('PUT', `/api/v2/profiles/${saved.id}`, {
    revision: saved.revision,
    document: doc({ description: 'edited' }),
  });
  expect(updated.status).toBe(200);
  expect((updated.json as ProfileDetailView).revision).not.toBe(saved.revision);

  // PUT names only the id, so a repo profile has to be found from where it lives.
  const repoSaved = repoProfile.json as ProfileDetailView;
  const repoUpdate = await call('PUT', `/api/v2/profiles/${repoSaved.id}`, {
    revision: repoSaved.revision,
    document: doc({
      name: 'repo-only',
      rules: [{ id: 'r', type: 'literal', match: 'Fabrikam', replace: 'Tailspin' }],
    }),
  });
  expect((repoUpdate.json as ProfileDetailView).scope).toEqual({ kind: 'repo', repoId });

  const deleted = await call('DELETE', `/api/v2/profiles/${saved.id}`, {
    revision: (updated.json as ProfileDetailView).revision,
  });
  expect(deleted.json).toEqual({ deleted: saved.id });
  expect((await call('GET', `/api/v2/profiles/${saved.id}`)).status).toBe(404);
});

it('refuses a stale revision instead of overwriting', async () => {
  const { call } = await fixture();
  const saved = (await call('POST', '/api/v2/profiles', { scope: global, document: doc() }))
    .json as ProfileDetailView;
  await call('PUT', `/api/v2/profiles/${saved.id}`, {
    revision: saved.revision,
    document: doc({ description: 'first' }),
  });
  const stale = await call('PUT', `/api/v2/profiles/${saved.id}`, {
    revision: saved.revision,
    document: doc({ description: 'second' }),
  });
  expect(stale.status).toBe(409);
  const staleDelete = await call('DELETE', `/api/v2/profiles/${saved.id}`, {
    revision: saved.revision,
  });
  expect(staleDelete.status).toBe(409);
  const read = (await call('GET', `/api/v2/profiles/${saved.id}`)).json as ProfileDetailView;
  expect(read.document).toMatchObject({ description: 'first' });
});

it('lets only one of two writers holding the same revision win', async () => {
  const { call } = await fixture();
  const saved = (await call('POST', '/api/v2/profiles', { scope: global, document: doc() }))
    .json as ProfileDetailView;
  const results = await Promise.all(
    ['a', 'b'].map((description) =>
      call('PUT', `/api/v2/profiles/${saved.id}`, {
        revision: saved.revision,
        document: doc({ description }),
      }),
    ),
  );
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
});

it('validates every body and query', async () => {
  const { call } = await fixture();
  const bad: [string, string, unknown][] = [
    ['GET', '/api/v2/profiles?repo=../../etc', undefined],
    ['POST', '/api/v2/profiles', { scope: { kind: 'other' }, document: doc() }],
    ['POST', '/api/v2/profiles', { scope: global, document: doc(), extra: true }],
    ['POST', '/api/v2/profiles', { scope: global, document: { kind: 'profile' } }],
    ['GET', '/api/v2/profiles/not-an-id', undefined],
    ['GET', '/api/v2/profiles/suggestions', undefined],
    ['PUT', '/api/v2/profiles/pf_x', { document: doc() }],
    ['DELETE', '/api/v2/profiles/pf_x', {}],
    ['POST', '/api/v2/profiles/validate', {}],
    ['POST', '/api/v2/profiles/test', { document: doc() }],
    ['POST', '/api/v2/profiles/test', { document: doc(), text: 'x'.repeat(65 * 1024) }],
    ['POST', '/api/v2/profiles/check', []],
  ];
  for (const [method, path, body] of bad)
    expect((await call(method, path, body)).status, `${method} ${path}`).toBe(400);
  expect((await call('GET', '/api/v2/profiles', undefined, 'wrong')).status).toBe(401);
  expect((await call('GET', '/api/v2/profiles/pf_missing')).status).toBe(404);
  expect((await call('GET', '/api/v2/schema/nope')).status).toBe(404);
});

it('serves JSON schemas by kind', async () => {
  const { call } = await fixture();
  const schema = await call('GET', '/api/v2/schema/profile');
  expect(schema.json).toMatchObject({ properties: { rules: { type: 'array' } } });
});

it('reports conflicts between profiles used together', async () => {
  const { call } = await fixture();
  const first = (await call('POST', '/api/v2/profiles', { scope: global, document: doc() }))
    .json as ProfileDetailView;
  const second = (
    await call('POST', '/api/v2/profiles', {
      scope: global,
      document: doc({
        name: 'other',
        rules: [{ id: 'x', type: 'literal', match: 'Contoso', replace: 'Tailspin' }],
      }),
    })
  ).json as ProfileDetailView;
  const refs = [first, second].map((item) => ({ id: item.id, scope: item.scope }));
  const conflict = await call('POST', '/api/v2/profiles/check', refs);
  expect(conflict.status).toBe(400);
  expect(JSON.stringify(conflict.json)).toContain('conflicts');
  const fine = await call('POST', '/api/v2/profiles/check', refs.slice(0, 1));
  expect(fine.json).toEqual({ profiles: 1, rules: 1 });
});

it('locates problems by path and tells errors from warnings', async () => {
  const { call } = await fixture();
  const problems = (document: unknown) =>
    call('POST', '/api/v2/profiles/validate', { document }).then(
      (result) => (result.json as { problems: ProblemView[] }).problems,
    );
  expect(await problems(doc())).toEqual([]);
  const shape = await problems(doc({ rules: [{ id: 'a', type: 'literal', match: 'x' }] }));
  expect(shape[0]?.path).toBe('rules.0.replace');
  const regex = await problems(
    doc({ rules: [{ id: 'a', type: 'regex', match: '(unclosed', replace: 'x$1' }] }),
  );
  expect(regex[0]).toMatchObject({ path: 'rules.0' });
  expect(regex[0]?.message).toContain('invalid regex');
  const irreversible = await problems(
    doc({ rules: [{ id: 'a', type: 'regex', match: 'CH-(\\d{6})', replace: 'CLM' }] }),
  );
  expect(irreversible[0]).toMatchObject({ path: 'rules.0.replace' });
  expect(irreversible[0]?.message).toContain('reversible');
  const duplicate = await problems(
    doc({
      rules: [
        { id: 'a', type: 'literal', match: 'Contoso', replace: 'Northwind' },
        { id: 'a', type: 'literal', match: 'Fabrikam', replace: 'Tailspin' },
      ],
    }),
  );
  expect(duplicate[0]?.message).toContain('duplicate rule id');
  const short = await problems(
    doc({ rules: [{ id: 'a', type: 'literal', match: 'Cor', replace: 'Northwind' }] }),
  );
  expect(short[0]).toMatchObject({ severity: 'warning', path: 'rules.0' });
});

it('accepts reversible regex forms', () => {
  for (const rule of [
    { match: 'CH-(\\d{6})', replace: 'CLM-$1' },
    { match: '(?<n>\\d+)', replace: 'N$<n>' },
    { match: 'Example', replace: 'Public' },
    { match: 'contoso\\.com', replace: 'acme.example' },
    { match: '(?<![A-Za-z0-9_])contoso\\.com(?![A-Za-z0-9_])', replace: 'acme.example' },
  ])
    expect(documentProblems(doc({ rules: [{ id: 'a', type: 'regex', ...rule }] }))).toEqual([]);
  for (const rule of [
    { match: 'x', replace: '' },
    { match: 'x', replace: "$'" },
    { match: 'a|b', replace: 'c' },
  ])
    expect(
      documentProblems(doc({ rules: [{ id: 'a', type: 'regex', ...rule }] })).length,
    ).toBeGreaterThan(0);
});

it('warns when another profile matches the same name', async () => {
  const { call } = await fixture();
  await call('POST', '/api/v2/profiles', {
    scope: global,
    document: doc({
      name: 'terms',
      rules: [{ id: 't', type: 'literal', match: 'Medicaid', replace: 'Program' }],
    }),
  });
  const result = await call('POST', '/api/v2/profiles/validate', {
    document: doc({
      rules: [{ id: 'a', type: 'literal', match: 'Medicaid Tier', replace: 'Plan Tier' }],
    }),
  });
  const [problem] = (result.json as { problems: ProblemView[] }).problems;
  expect(problem).toMatchObject({ severity: 'warning', path: 'rules.0.match' });
  expect(problem?.message).toContain('terms');
  expect(problem?.message).toContain('Longest match wins');
});

it('refuses secret values and never echoes them', async () => {
  const { call } = await fixture();
  const inRule = doc({
    rules: [{ id: 'a', type: 'literal', match: fakeToken, replace: 'Northwind' }],
  });
  const inField = doc({
    rules: [{ id: 's', type: 'secret', detector: 'github-token', value: 'hunter2hunter2' }],
  });
  const inExtension = doc({ extensions: { note: `token ${fakeToken}` } });
  for (const document of [inRule, inField, inExtension]) {
    const result = await call('POST', '/api/v2/profiles/validate', { document });
    const { problems } = result.json as { problems: ProblemView[] };
    expect(problems.some((problem) => problem.severity === 'secret')).toBe(true);
    expect(JSON.stringify(result.json)).not.toContain(fakeToken);
    expect(JSON.stringify(result.json)).not.toContain('hunter2');
    const saved = await call('POST', '/api/v2/profiles', { scope: global, document });
    expect(saved.status).toBe(400);
    expect(JSON.stringify(saved.json)).not.toContain(fakeToken);
  }
  const allowed = doc({ rules: [{ id: 's', type: 'secret', detector: 'github-token' }] });
  expect(documentProblems(allowed)).toEqual([]);
});

it('tests text: cloaks, restores and reports the round trip', async () => {
  const { call } = await fixture();
  const test = async (document: unknown, text: string) =>
    (await call('POST', '/api/v2/profiles/test', { document, text })).json as ProfileTestResult;
  const fine = await test(doc(), 'using Contoso.Claims;\n// contoso');
  expect(fine.cloaked).toBe('using Northwind.Claims;\n// northwind');
  expect(fine.restored).toBe('using Contoso.Claims;\n// contoso');
  expect(fine.roundTrips).toBe(true);
  expect(fine.problems).toEqual([]);

  const clash = await test(doc(), 'Contoso and Northwind');
  expect(clash.roundTrips).toBe(false);
  expect(clash.problems[0]?.message).toContain('already contains');

  const invalid = await test(doc({ rules: 'nope' }), 'Contoso');
  expect(invalid.roundTrips).toBe(false);
  expect(invalid.problems[0]?.path).toBe('rules');

  const secret = await test(
    doc({ rules: [{ id: 's', type: 'secret', detector: 'github-token' }] }),
    `t=${fakeToken}`,
  );
  expect(secret.cloaked).toContain('REDACTED_GITHUB_TOKEN_1');
  expect(secret.cloaked).not.toContain(fakeToken);
  expect(secret.roundTrips).toBe(true);
});

it('counts hits per rule, honouring exclusions and refusing symlinks out', async () => {
  const { root, source, call, repoId } = await fixture();
  await writeFile(join(source, 'a.ts'), 'Contoso contoso\n');
  await writeFile(join(source, 'kept.ts'), 'Contoso\n');
  await mkdir(join(source, 'deploy'));
  await writeFile(join(source, 'deploy', 'x.ts'), 'Contoso Contoso Contoso\n');
  await writeFile(join(root, 'outside.txt'), 'Contoso Contoso Contoso\n');
  await symlink(join(root, 'outside.txt'), join(source, 'link.ts'));
  const saved = (
    await call('POST', '/api/v2/profiles', {
      scope: global,
      document: doc({ exclude: ['deploy/'] }),
    })
  ).json as ProfileDetailView;
  const read = (await call('GET', `/api/v2/profiles/${saved.id}?repo=${repoId}`))
    .json as ProfileDetailView;
  expect(read.hits).toEqual({ company: 3 });
  const noRepo = (await call('GET', `/api/v2/profiles/${saved.id}`)).json as ProfileDetailView;
  expect(noRepo.hits).toEqual({});
});

it('reports locked exclusions from the repository', async () => {
  const { dashboard, call, repoId } = await fixture();
  await dashboard.sync.saveExclusions(repoId, { patterns: ['secrets/'] });
  const saved = (await call('POST', '/api/v2/profiles', { scope: global, document: doc() }))
    .json as ProfileDetailView;
  const read = (await call('GET', `/api/v2/profiles/${saved.id}?repo=${repoId}`))
    .json as ProfileDetailView;
  expect(read.lockedExclusions).toEqual([{ pattern: 'secrets/', source: 'global' }]);
});

it('counts the workspaces using a profile as zero when none do', async () => {
  const { call } = await fixture();
  const saved = (await call('POST', '/api/v2/profiles', { scope: global, document: doc() }))
    .json as ProfileDetailView;
  expect(saved.usedBy).toBe(0);
});

it('suggests names found by shape and drops ones already covered', async () => {
  const { source, call, repoId } = await fixture();
  await writeFile(
    join(source, 'a.ts'),
    'FabrikamClaims FabrikamBilling ContosoClaims ContosoBilling NHSN NHSN NHSN https://api.fabrikam-health.com ch-prod-sql01',
  );
  await writeFile(join(source, 'b.ts'), `HTTP HTTP HTTP UserService UserModel t=${fakeToken}`);
  await call('POST', '/api/v2/profiles', { scope: global, document: doc() });
  const { suggestions } = (await call('GET', `/api/v2/profiles/suggestions?repo=${repoId}`))
    .json as { suggestions: ProfileSuggestion[] };
  const texts = suggestions.map((item) => item.text);
  expect(texts).toEqual(
    expect.arrayContaining(['Fabrikam', 'NHSN', 'api.fabrikam-health.com', 'ch-prod-sql01']),
  );
  expect(texts).not.toContain('Contoso');
  expect(texts).not.toContain('HTTP');
  expect(texts).not.toContain('User');
  expect(JSON.stringify(suggestions)).not.toContain(fakeToken);
});

it('never suggests a detected secret, and caps the list', () => {
  const texts = [
    `${fakeToken} ${fakeToken} ${fakeToken}`,
    Array.from({ length: 12 }, (_, i) => `host${i}.corp`).join(' '),
  ];
  const found = collectSuggestions(texts, []);
  expect(found.length).toBeLessThanOrEqual(8);
  expect(JSON.stringify(found)).not.toContain(fakeToken);
});

it('keeps the detector list the browser shows in step with the engine', async () => {
  const { secretDetectorOptions } = await import('../../src/web/screens/profiles/rules.js');
  expect(secretDetectorOptions).toEqual(secretDetectors.map(({ id, name }) => ({ id, name })));
});

it('records saves in the audit log by id, never by name', async () => {
  const { dashboard, call } = await fixture();
  const saved = (await call('POST', '/api/v2/profiles', { scope: global, document: doc() }))
    .json as ProfileDetailView;
  await call('DELETE', `/api/v2/profiles/${saved.id}`, { revision: saved.revision });
  const page = (await dashboard.sync.audit.list()).events;
  const details = page.map((event) => event.detail ?? '');
  expect(details).toEqual(
    expect.arrayContaining([`Created profile ${saved.id}`, `Deleted profile ${saved.id}`]),
  );
  expect(JSON.stringify(page)).not.toContain('names');
});

describe('regex hardening', () => {
  const unsafe = doc({
    rules: [{ id: 'evil', type: 'regex', match: '(a+)+$', replace: 'x$&' }],
  });
  const slow = doc({
    rules: [{ id: 'slow', type: 'regex', match: '^(.*?,){14}P', replace: 'x$&' }],
  });
  const slowText = 'a,'.repeat(4000);

  it('rejects (a+)+$ at validation, located on the rule', async () => {
    const { call } = await fixture();
    const result = await call('POST', '/api/v2/profiles/validate', { document: unsafe });
    const { problems } = result.json as { problems: ProblemView[] };
    expect(problems[0]?.path).toBe('rules.0.match');
    expect(problems[0]?.message).toMatch(/unsafe regex.*nested/);
  });
  it('refuses to save it or preview it', async () => {
    const { call } = await fixture();
    const created = await call('POST', '/api/v2/profiles', { scope: global, document: unsafe });
    expect(created.status).toBe(400);
    expect((created.json as { error: string }).error).toMatch(/unsafe regex/);
    const tested = await call('POST', '/api/v2/profiles/test', { document: unsafe, text: 'aaa' });
    expect((tested.json as ProfileTestResult).problems[0]?.message).toMatch(/unsafe regex/);
  });
  it('a slow regex the static check misses times out the tester while the server answers', async () => {
    const { call } = await fixture();
    const pending = call('POST', '/api/v2/profiles/test', { document: slow, text: slowText });
    const started = performance.now();
    const other = await call('GET', '/api/v2/profiles');
    expect(other.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1500);
    const tested = (await pending).json as ProfileTestResult;
    expect(tested.problems[0]?.message).toMatch(/regex did not finish within 2s/);
    expect(tested.roundTrips).toBe(false);
  }, 30_000);
  it('the tester still works for a normal regex', async () => {
    const { call } = await fixture();
    const document = doc({
      rules: [{ id: 'r', type: 'regex', match: 'CH-(\\d+)', replace: 'CLM-$1' }],
    });
    const tested = await call('POST', '/api/v2/profiles/test', { document, text: 'see CH-12' });
    expect(tested.json).toMatchObject({
      cloaked: 'see CLM-12',
      restored: 'see CH-12',
      roundTrips: true,
    });
  });
  it('hit counting reports a timeout instead of partial numbers', async () => {
    const { call, source, repoId } = await fixture();
    await writeFile(join(source, 'big.txt'), slowText);
    const created = await call('POST', '/api/v2/profiles', { scope: global, document: slow });
    const { id } = created.json as ProfileDetailView;
    const detail = await call('GET', `/api/v2/profiles/${id}?repo=${repoId}`);
    expect((detail.json as ProfileDetailView).hitsError).toMatch(
      /Hits are incomplete: .*regex did not finish/,
    );
  }, 30_000);
  it('a saved profile that now fails is listed with its problem and still opens', async () => {
    const { call, store, repoId, source } = await fixture();
    await writeFile(join(source, 'a.txt'), 'aaa\n');
    await store.writeSealed('profiles/pf_old.json', 'pf_old', 'profile', unsafe);
    const list = await call('GET', '/api/v2/profiles');
    expect(list.status).toBe(200);
    const [item] = (list.json as { profiles: ProfileListItem[] }).profiles;
    expect(item?.problem).toMatch(/names\/evil: unsafe regex/);
    const detail = await call('GET', `/api/v2/profiles/pf_old?repo=${repoId}`);
    expect(detail.status).toBe(200);
    const view = detail.json as ProfileDetailView;
    expect(view.document).toEqual(unsafe);
    expect(view.hitsError).toMatch(/unsafe regex/);
    expect(view.hits).toEqual({});
  });
  it('checking that profile names the rule, and fixing it clears the problem', async () => {
    const { call, store } = await fixture();
    await store.writeSealed('profiles/pf_old.json', 'pf_old', 'profile', unsafe);
    const check = await call('POST', '/api/v2/profiles/check', [{ id: 'pf_old', scope: global }]);
    expect(check.status).toBe(400);
    expect((check.json as { error: string }).error).toMatch(/names\/evil: unsafe regex/);
    const detail = (await call('GET', '/api/v2/profiles/pf_old')).json as ProfileDetailView;
    const fixed = await call('PUT', '/api/v2/profiles/pf_old', {
      revision: detail.revision,
      document: doc(),
    });
    expect(fixed.status).toBe(200);
    const list = await call('GET', '/api/v2/profiles');
    expect((list.json as { profiles: ProfileListItem[] }).profiles[0]?.problem).toBeUndefined();
  });
});

describe('profile@2 routes', () => {
  const v2 = (name: string, match: string, extra: Record<string, unknown> = {}) => ({
    kind: 'profile',
    schemaVersion: 2,
    name,
    rules: [{ id: 'r', type: 'literal', match, replace: `${match}Anon` }],
    ...extra,
  });
  const repoScope = (repoId: string) => ({ kind: 'repo', repoId });
  it('reports v1 documents using the new fields, with the path', async () => {
    const { call } = await fixture();
    const { json } = await call('POST', '/api/v2/profiles/validate', {
      document: doc({ allowRoots: ['src/'] }),
    });
    expect((json as { problems: ProblemView[] }).problems[0]).toMatchObject({
      path: 'allowRoots',
      message: expect.stringContaining('schemaVersion') as string,
    });
  });
  it('locates a bad root', async () => {
    const { call } = await fixture();
    const { json } = await call('POST', '/api/v2/profiles/validate', {
      document: v2('a', 'Aa', { allowRoots: ['src/', '../x'] }),
    });
    expect((json as { problems: ProblemView[] }).problems[0]?.path).toBe('allowRoots.1');
  });
  it('refuses a missing parent, a cycle and a self reference on save', async () => {
    const { call } = await fixture();
    const missing = await call('POST', '/api/v2/profiles', {
      scope: global,
      document: v2('child', 'Cc', { extends: ['gone'] }),
    });
    expect(missing.status).toBe(400);
    expect((missing.json as { error: string }).error).toMatch(/extends "gone"/);
    const self = await call('POST', '/api/v2/profiles', {
      scope: global,
      document: v2('self', 'Ss', { extends: ['self'] }),
    });
    expect(self.status).toBe(400);
    const a = await call('POST', '/api/v2/profiles', { scope: global, document: v2('a', 'Aa') });
    await call('POST', '/api/v2/profiles', {
      scope: global,
      document: v2('b', 'Bb', { extends: ['a'] }),
    });
    const parent = a.json as ProfileDetailView;
    const cycle = await call('PUT', `/api/v2/profiles/${parent.id}`, {
      revision: parent.revision,
      document: v2('a', 'Aa', { extends: ['b'] }),
    });
    expect(cycle.status).toBe(400);
    expect((cycle.json as { error: string }).error).toMatch(/a -> b -> a/);
  });
  it('reports a conflict with a parent while editing', async () => {
    const { call } = await fixture();
    await call('POST', '/api/v2/profiles', { scope: global, document: v2('base', 'Base') });
    const { json } = await call('POST', '/api/v2/profiles/validate', {
      document: {
        ...v2('child', 'x', { extends: ['base'] }),
        rules: [{ id: 'r', type: 'literal', match: 'Base', replace: 'Other' }],
      },
    });
    expect((json as { problems: ProblemView[] }).problems[0]).toMatchObject({
      path: 'extends',
      message: expect.stringContaining('same original') as string,
    });
  });
  it('resolves repo parents only when validating in that repo scope', async () => {
    const { call, repoId } = await fixture();
    await call('POST', '/api/v2/profiles', {
      scope: repoScope(repoId),
      document: v2('own', 'Own'),
    });
    const document = v2('child', 'Cc', { extends: ['own'] });
    const asRepo = await call('POST', '/api/v2/profiles/validate', {
      document,
      scope: repoScope(repoId),
    });
    const found = (asRepo.json as { problems: ProblemView[] }).problems;
    expect(found.filter((problem) => problem.severity !== 'warning')).toEqual([]);
    const asGlobal = await call('POST', '/api/v2/profiles/validate', { document, scope: global });
    expect((asGlobal.json as { problems: ProblemView[] }).problems[0]?.path).toBe('extends');
  });
  it('previews and counts hits through the parent', async () => {
    const { call, source, repoId } = await fixture();
    await writeFile(join(source, 'a.txt'), 'Base Kid\n');
    await call('POST', '/api/v2/profiles', { scope: global, document: v2('base', 'Base') });
    const child = v2('child', 'Kid', { extends: ['base'] });
    const tested = await call('POST', '/api/v2/profiles/test', {
      document: child,
      text: 'Base Kid',
      scope: global,
    });
    expect((tested.json as ProfileTestResult).cloaked).toBe('BaseAnon KidAnon');
    const created = await call('POST', '/api/v2/profiles', { scope: global, document: child });
    const { id } = created.json as ProfileDetailView;
    const list = await call('GET', '/api/v2/profiles');
    const item = (list.json as { profiles: ProfileListItem[] }).profiles.find(
      (entry) => entry.id === id,
    );
    expect(item?.extends).toEqual(['base']);
    const detail = await call('GET', `/api/v2/profiles/${id}?repo=${repoId}`);
    expect(Object.values((detail.json as ProfileDetailView).hits)).toHaveLength(1);
  });
  it('does not count hits outside allowRoots', async () => {
    const { call, source, repoId } = await fixture();
    await mkdir(join(source, 'src'));
    await writeFile(join(source, 'src', 'a.txt'), 'Acme\n');
    await writeFile(join(source, 'b.txt'), 'Acme Acme\n');
    const created = await call('POST', '/api/v2/profiles', {
      scope: global,
      document: v2('scoped', 'Acme', { allowRoots: ['src/'] }),
    });
    const { id } = created.json as ProfileDetailView;
    const detail = await call('GET', `/api/v2/profiles/${id}?repo=${repoId}`);
    expect((detail.json as ProfileDetailView).hits).toEqual({ r: 1 });
  });
  it('refuses to delete or rename a parent, and allows it once nothing extends it', async () => {
    const { call } = await fixture();
    const base = await call('POST', '/api/v2/profiles', {
      scope: global,
      document: v2('base', 'Base'),
    });
    const parent = base.json as ProfileDetailView;
    const child = await call('POST', '/api/v2/profiles', {
      scope: global,
      document: v2('child', 'Kid', { extends: ['base'] }),
    });
    const kid = child.json as ProfileDetailView;
    const deleted = await call('DELETE', `/api/v2/profiles/${parent.id}`, {
      revision: parent.revision,
    });
    expect(deleted.status).toBe(409);
    expect((deleted.json as { error: string }).error).toMatch(/child extend it/);
    const renamed = await call('PUT', `/api/v2/profiles/${parent.id}`, {
      revision: parent.revision,
      document: v2('renamed', 'Base'),
    });
    expect(renamed.status).toBe(409);
    const kept = await call('PUT', `/api/v2/profiles/${parent.id}`, {
      revision: parent.revision,
      document: v2('base', 'Base2'),
    });
    expect(kept.status).toBe(200);
    await call('DELETE', `/api/v2/profiles/${kid.id}`, { revision: kid.revision });
    const after = await call('DELETE', `/api/v2/profiles/${parent.id}`, {
      revision: (kept.json as ProfileDetailView).revision,
    });
    expect(after.status).toBe(200);
  });
  it('a parent deleted behind the screen shows as a problem, not a crash', async () => {
    const { call, store, repoId } = await fixture();
    await store.writeSealed(
      'profiles/pf_orphan.json',
      'pf_orphan',
      'profile',
      v2('orphan', 'Oo', { extends: ['gone'] }),
    );
    const detail = await call('GET', `/api/v2/profiles/pf_orphan?repo=${repoId}`);
    expect(detail.status).toBe(200);
    expect((detail.json as ProfileDetailView).hitsError).toMatch(/extends "gone"/);
  });
});
