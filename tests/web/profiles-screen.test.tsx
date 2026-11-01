// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Overview } from '../../src/web/api/contracts.js';
import { ProfilesScreen } from '../../src/web/screens/profiles/index.js';
import { drafts, listError, profileList } from '../../src/web/screens/profiles/state.js';
import { commands } from '../../src/web/shell/commands.js';
import { startSession } from '../../src/web/shell/load.js';
import { overview } from '../../src/web/shell/state.js';
import { toasts } from '../../src/web/shell/ui/index.js';

const repoId = 'a'.repeat(16);
const docA = {
  kind: 'profile',
  schemaVersion: 1,
  name: 'contoso',
  rules: [
    { id: 'company', type: 'literal', match: 'Contoso', replace: 'Northwind' },
    { id: 'key', type: 'secret', detector: 'github-token' },
  ],
  exclude: ['deploy/'],
};
type Handler = (body: never, url: URL) => { status?: number; json: unknown };
let routes: Record<string, Handler>;
let calls: { key: string; body: unknown }[];
let root: HTMLElement;
let stop: () => void;

const detail = (document: unknown = docA, revision = 'rev1') => ({
  id: 'pf_a',
  scope: { kind: 'global' },
  revision,
  document,
  hits: { company: 12 },
  lockedExclusions: [{ pattern: '.env*', source: 'policy' }],
  usedBy: 2,
});
/** act() only flushes when it ends, so wait in steps for each load to render the next. */
async function settle(ms = 480) {
  for (let waited = 0; waited < ms; waited += 60)
    await act(async () => {
      await new Promise((done) => setTimeout(done, 60));
    });
}
const button = (name: string | RegExp) =>
  [...root.querySelectorAll('button')].find((item) =>
    typeof name === 'string'
      ? item.textContent?.trim() === name || item.getAttribute('aria-label') === name
      : name.test(item.textContent ?? ''),
  ) as HTMLButtonElement | undefined;
const byLabel = <T extends HTMLElement = HTMLInputElement>(label: string) =>
  root.querySelector(`[aria-label="${label}"]`) as T | null;
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function click(element: HTMLElement | null | undefined) {
  if (!element) throw new Error('Nothing to click');
  await act(async () => {
    element.click();
  });
}
async function show(profileId?: string, json?: boolean) {
  await act(async () => {
    render(<ProfilesScreen profileId={profileId} json={json} />, root);
  });
  await settle();
}

beforeEach(() => {
  location.hash = '';
  drafts.value = {};
  profileList.value = [];
  listError.value = null;
  toasts.value = [];
  calls = [];
  overview.value = {
    launch: { kind: 'repo', repoId, label: 'api', path: '/x', branch: 'main' },
    repos: [{ id: repoId, name: 'api', path: '/x', missing: false, workspaceCount: 0 }],
    groups: [],
    workspaces: [],
    pendingAgentRequests: 0,
    profileCount: 1,
    workspacesRoot: null,
  } satisfies Overview;
  routes = {
    'GET /api/v2/session': () => ({ json: {} }),
    'GET /api/v2/overview': () => ({ json: overview.value }),
    'GET /api/v2/profiles': () => ({
      json: {
        profiles: [
          {
            id: 'pf_a',
            name: 'contoso',
            scope: { kind: 'global' },
            ruleCount: 2,
            exclusionCount: 1,
          },
        ],
      },
    }),
    'GET /api/v2/profiles/pf_a': () => ({ json: detail() }),
    'GET /api/v2/profiles/suggestions': () => ({
      json: { suggestions: [{ text: 'ContosoRx', reason: 'PascalCase prefix', hits: 6 }] },
    }),
    'POST /api/v2/profiles/validate': () => ({ json: { problems: [] } }),
    'POST /api/v2/profiles/test': () => ({
      json: { cloaked: 'Northwind', restored: 'Contoso', roundTrips: true, problems: [] },
    }),
  };
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: `No ${key}` }), { status: 404 });
    const result = handler(body as never, url);
    return new Response(JSON.stringify(result.json), { status: result.status ?? 200 });
  });
  stop = startSession({ token: 't', launch: {}, route: '' }, request as typeof fetch);
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => {
  stop();
  render(null, root);
  root.remove();
});

it('lists profiles with scope and counts, and shows presets', async () => {
  await show();
  const nav = root.querySelector('nav[aria-label="Profiles"]');
  expect(nav?.textContent).toContain('contoso');
  expect(nav?.textContent).toContain('global');
  expect(nav?.textContent).toContain('2 rules · 1 exclusion');
  expect(nav?.textContent).toContain('Exclusion presets');
  expect(nav?.textContent).toContain('Lockfiles');
});

it('shows why a saved profile cannot be used, its parents and its roots', async () => {
  routes['GET /api/v2/profiles'] = () => ({
    json: {
      profiles: [
        {
          id: 'pf_a',
          name: 'contoso',
          scope: { kind: 'global' },
          ruleCount: 2,
          exclusionCount: 1,
          problem: 'contoso/bad: unsafe regex: an unbounded quantifier is nested in another',
          extends: ['base'],
        },
      ],
    },
  });
  routes['GET /api/v2/profiles/pf_a'] = () => ({
    json: {
      ...detail({ ...docA, schemaVersion: 2, extends: ['base'], allowRoots: ['src/'] }),
      hitsError: 'Hits are incomplete: regex did not finish within 2s',
    },
  });
  await show('pf_a');
  const nav = root.querySelector('nav[aria-label="Profiles"]');
  expect(nav?.textContent).toContain('extends base');
  expect(nav?.querySelector('.pf-row-error')?.textContent).toContain('unsafe regex');
  const panels = root.querySelector('.pf-panels');
  expect(panels?.textContent).toContain('Hits are incomplete');
  expect(panels?.textContent).toContain('Extends base.');
  expect(panels?.textContent).toContain('Files only from src/');
});

it('shows the rules table with type, find, replace, case and hits', async () => {
  await show();
  const table = root.querySelector('[role="table"]');
  expect(table?.textContent).toContain('Brand');
  expect(table?.textContent).toContain('Secret');
  expect(table?.textContent).toContain('12');
  // A scan ran and found nothing for this rule, which is not the same as unknown.
  expect(root.querySelector('[aria-label="Rule 2"] .pf-hits')?.textContent).toBe('0');
  expect(byLabel('Find for rule 1')?.value).toBe('Contoso');
  expect(byLabel('Replace for rule 1')?.value).toBe('Northwind');
  expect(byLabel<HTMLSelectElement>('Case for rule 1')?.value).toBe('preserve');
  expect(byLabel<HTMLSelectElement>('Detector for rule 2')?.value).toBe('github-token');
  expect(root.textContent).toContain('used by 2 workspaces');
  expect(root.textContent).toContain('hits in api');
});

it.each(['Brand', 'Keyword', 'Business term', 'Regex', 'Secret'])(
  'adds a rule with the + %s button',
  async (kind) => {
    await show();
    await click(button(`+ ${kind}`));
    expect(root.querySelector('[aria-label="Rule 3"]')).not.toBeNull();
    const text = drafts.value.pf_a?.text ?? '';
    expect(JSON.parse(text).rules).toHaveLength(3);
  },
);

it('locks inherited never-pull patterns and edits the profile own ones', async () => {
  await show();
  const chips = byLabel<HTMLElement>('Never pull patterns');
  expect(chips?.textContent).toContain('.env*');
  expect(chips?.textContent).toContain('policy · locked');
  expect(button('Remove .env*')).toBeUndefined();
  await click(button('Remove deploy/'));
  expect(JSON.parse(drafts.value.pf_a?.text ?? '')).not.toHaveProperty('exclude');
  const add = byLabel('Add never pull pattern') as HTMLInputElement;
  await type(add, 'secrets/');
  await act(async () => {
    add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  expect(JSON.parse(drafts.value.pf_a?.text ?? '').exclude).toEqual(['secrets/']);
});

it('toggles an exclusion preset on the open profile', async () => {
  await show();
  const box = [...root.querySelectorAll('label')]
    .find((label) => label.textContent?.includes('Lockfiles'))
    ?.querySelector('input') as HTMLInputElement;
  await act(async () => {
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(JSON.parse(drafts.value.pf_a?.text ?? '').exclude).toContain('yarn.lock');
});

it('tests pasted text and reports the round trip', async () => {
  await show();
  await type(root.querySelector('#pf-try') as HTMLTextAreaElement, 'Contoso');
  await settle();
  expect(byLabel<HTMLElement>('Cloaked text')?.textContent).toBe('Northwind');
  expect(byLabel<HTMLElement>('Round trip result')?.textContent).toContain('identical to source');
  routes['POST /api/v2/profiles/test'] = () => ({
    json: {
      cloaked: '',
      restored: '',
      roundTrips: false,
      problems: [{ path: '', message: 'source already contains an anonymized value' }],
    },
  });
  await type(root.querySelector('#pf-try') as HTMLTextAreaElement, 'Northwind');
  await settle();
  expect(byLabel<HTMLElement>('Round trip result')?.textContent).toContain('does not round trip');
  expect(byLabel<HTMLElement>('Round trip result')?.textContent).toContain('already contains');
});

it('adds a rule from a suggestion', async () => {
  await show();
  expect(root.textContent).toContain('ContosoRx');
  await click(button('Add rule for ContosoRx'));
  expect(byLabel('Find for rule 3')?.value).toBe('ContosoRx');
  expect(button('Add rule for ContosoRx')).toBeUndefined();
});

it('saves with the revision it loaded, and only when something changed', async () => {
  routes['PUT /api/v2/profiles/pf_a'] = () => ({
    json: detail({ ...docA, description: 'x' }, 'rev2'),
  });
  await show();
  expect(button('Save')?.disabled).toBe(true);
  await type(byLabel('Replace for rule 1') as HTMLInputElement, 'Tailspin');
  await settle();
  routes['GET /api/v2/profiles/pf_a'] = () => ({ json: detail(docA, 'rev2') });
  await click(button('Save'));
  await settle(120);
  const put = calls.find((item) => item.key === 'PUT /api/v2/profiles/pf_a');
  expect(put?.body).toMatchObject({
    revision: 'rev1',
    document: { rules: [{ replace: 'Tailspin' }, {}] },
  });
  expect(drafts.value.pf_a?.revision).toBe('rev2');
});

it('blocks saving while there are errors and counts them', async () => {
  routes['POST /api/v2/profiles/validate'] = () => ({
    json: { problems: [{ path: 'rules.0.replace', message: 'Replacement is required' }] },
  });
  await show();
  await type(byLabel('Replace for rule 1') as HTMLInputElement, '');
  await settle();
  expect(button(/fix 1 error/)?.disabled).toBe(true);
  expect(root.querySelector('[aria-label="Rule 1"]')?.textContent).toContain(
    'Replacement is required',
  );
});

it('offers a reload instead of overwriting when the profile changed elsewhere', async () => {
  routes['PUT /api/v2/profiles/pf_a'] = () => ({ status: 409, json: { error: 'changed' } });
  await show();
  await type(byLabel('Replace for rule 1') as HTMLInputElement, 'Tailspin');
  await settle();
  await click(button('Save'));
  await settle(120);
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('changed in another tab');
  expect(drafts.value.pf_a?.text).toContain('Tailspin');
  await click(button('Reload and discard my edits'));
  await settle(120);
  expect(drafts.value.pf_a?.text).not.toContain('Tailspin');
  expect(root.querySelector('[role="alert"]')).toBeNull();
});

it('creates a profile in the chosen scope', async () => {
  routes['POST /api/v2/profiles'] = () => ({ json: { ...detail(), id: 'pf_new' } });
  routes['GET /api/v2/profiles/pf_new'] = () => ({ json: { ...detail(), id: 'pf_new' } });
  await show('new');
  await type(byLabel('Profile name') as HTMLInputElement, 'fresh');
  await settle();
  const scope = [...root.querySelectorAll('select')].find((item) =>
    item.textContent?.includes('All repositories'),
  ) as HTMLSelectElement;
  await act(async () => {
    scope.value = repoId;
    scope.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click(button('Save'));
  await settle(120);
  expect(calls.find((item) => item.key === 'POST /api/v2/profiles')?.body).toMatchObject({
    scope: { kind: 'repo', repoId },
    document: { name: 'fresh' },
  });
  expect(drafts.value.new).toBeUndefined();
  expect(location.hash).toBe('#/profiles/pf_new');
});

it('deletes with the current revision after confirming', async () => {
  routes['DELETE /api/v2/profiles/pf_a'] = () => ({ json: { deleted: 'pf_a' } });
  await show();
  await click(button('Delete'));
  expect(calls.some((item) => item.key.startsWith('DELETE'))).toBe(false);
  await click(button('Delete profile'));
  await settle(120);
  expect(calls.find((item) => item.key.startsWith('DELETE'))?.body).toEqual({ revision: 'rev1' });
});

it('reports conflict checks in a toast', async () => {
  routes['POST /api/v2/profiles/check'] = () => ({ json: { profiles: 1, rules: 2 } });
  await show();
  await click(button('Check conflicts'));
  await settle(120);
  expect(toasts.value.at(-1)?.message).toContain('No conflicts across 1 profiles, 2 rules');
  routes['POST /api/v2/profiles/check'] = () => ({
    status: 400,
    json: { error: 'a conflicts with b' },
  });
  await click(button('Check conflicts'));
  await settle(120);
  expect(toasts.value.at(-1)).toMatchObject({ message: 'a conflicts with b', tone: 'error' });
});

it('shows a clear page for a profile that no longer exists', async () => {
  await show('pf_gone');
  expect(root.textContent).toContain('Profile unavailable');
});

it('shows an empty state with no profiles', async () => {
  routes['GET /api/v2/profiles'] = () => ({ json: { profiles: [] } });
  await show();
  expect(root.textContent).toContain('No profiles yet');
});

it('adds palette entries while mounted and removes them after', async () => {
  await show();
  expect(commands.value.map((item) => item.title)).toEqual(
    expect.arrayContaining(['New profile', 'contoso']),
  );
  await act(async () => {
    render(null, root);
  });
  expect(commands.value.some((item) => item.title === 'New profile')).toBe(false);
});

it('JSON mode locates problems by line and blocks save', async () => {
  routes['POST /api/v2/profiles/validate'] = () => ({
    json: {
      problems: [
        { path: 'rules.0.replace', message: 'Regex replacement must be reversible.' },
        { path: 'rules.0.match', message: 'Overlaps.', severity: 'warning' },
      ],
    },
  });
  await show('pf_a', true);
  const text = drafts.value.pf_a?.text ?? '';
  const line = text.split('\n').findIndex((item) => item.includes('"replace"')) + 1;
  const panel = root.querySelector('[aria-label="Problems"]');
  expect(panel?.textContent).toContain(`Line ${line}: Regex replacement must be reversible.`);
  expect(button(/fix 1 error/)?.disabled).toBe(true);
  expect(root.querySelector('.pf-back .pf-line-err')).not.toBeNull();
  expect(root.querySelector('.pf-back .pf-line-warn')).not.toBeNull();
  const outline = root.querySelector('[aria-label="Outline"]');
  expect(outline?.textContent).toContain('rules 2');
  expect(outline?.textContent).toContain('brand 1 · secret 1');
  expect(outline?.textContent).toContain('exclude 1 + 1 inherited');
});

it('JSON mode reports text that does not parse without calling the server', async () => {
  await show('pf_a', true);
  calls.length = 0;
  await type(byLabel('Profile JSON') as HTMLTextAreaElement, '{\n"a":\n}');
  await settle();
  expect(root.querySelector('[aria-label="Problems"]')?.textContent).toContain('Line 3');
  expect(calls.some((item) => item.key.endsWith('/validate'))).toBe(false);
  location.hash = '#/profiles/pf_a/json';
  await click(root.querySelector('[data-tab="form"]') as HTMLElement);
  expect(location.hash).toBe('#/profiles/pf_a/json');
  expect(toasts.value.at(-1)?.message).toContain('Correct the JSON');
});

it('keeps edits when moving between form and JSON', async () => {
  await show('pf_a', true);
  await type(
    byLabel('Profile JSON') as HTMLTextAreaElement,
    JSON.stringify({ ...docA, name: 'edited' }, null, 2),
  );
  await show('pf_a', false);
  expect(byLabel('Profile name')?.value).toBe('edited');
});

async function pasteFlow(pasted: unknown) {
  await show('pf_a', true);
  await click(button('Paste from LLM'));
  await type(byLabel('Pasted profile JSON') as HTMLTextAreaElement, JSON.stringify(pasted));
  await click(button('Check and diff'));
  await settle(120);
}

it('Paste from LLM diffs and applies only what was accepted, without saving', async () => {
  await pasteFlow({
    ...docA,
    rules: [
      { id: 'company', type: 'literal', match: 'Contoso', replace: 'Tailspin' },
      { id: 'key', type: 'secret', detector: 'github-token' },
      { id: 'more', type: 'literal', match: 'Fabrikam', replace: 'Adventure' },
    ],
  });
  const list = byLabel<HTMLElement>('Changes');
  expect(list?.textContent).toContain('changed Rule company');
  expect(list?.textContent).toContain('added Rule more');
  expect(button(/Apply 0 accepted/)?.disabled).toBe(true);
  const box = [...(list?.querySelectorAll('label') ?? [])]
    .find((label) => label.textContent?.includes('Rule more'))
    ?.querySelector('input') as HTMLInputElement;
  await act(async () => {
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click(button(/Apply 1 accepted/));
  const saved = JSON.parse(drafts.value.pf_a?.text ?? '');
  expect(saved.rules.map((rule: { id: string }) => rule.id)).toEqual(['company', 'key', 'more']);
  expect(saved.rules[0].replace).toBe('Northwind');
  expect(calls.some((item) => item.key.startsWith('PUT'))).toBe(false);
});

it('Paste from LLM refuses secret values and discards the paste', async () => {
  routes['POST /api/v2/profiles/validate'] = () => ({
    json: {
      problems: [
        { path: 'rules.1.value', message: 'Secret rules hold no value.', severity: 'secret' },
      ],
    },
  });
  await pasteFlow({ ...docA, rules: [{ id: 's', type: 'secret', detector: 'jwt', value: 'x' }] });
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('Refused');
  expect(byLabel<HTMLTextAreaElement>('Pasted profile JSON')?.value).toBe('');
  expect(byLabel('Changes')).toBeNull();
  expect(button(/accepted/)).toBeUndefined();
});

it('Paste from LLM shows validation errors instead of a diff', async () => {
  routes['POST /api/v2/profiles/validate'] = () => ({
    json: { problems: [{ path: 'rules', message: 'Expected array' }] },
  });
  await pasteFlow({ rules: 'nope' });
  expect(root.textContent).toContain('Expected array');
  expect(byLabel('Changes')).toBeNull();
});
