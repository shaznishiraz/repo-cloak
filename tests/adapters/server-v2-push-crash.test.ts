import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { afterEach, expect, it, vi } from 'vitest';
import type { OperationState, PushReview } from '../../src/web/api/contracts.js';
import { cleanupFixtures, editedLines, fixture } from '../support/push-fixture.js';

/**
 * A crash, in-process: from the chosen write on, every durable write fails, so no rollback can
 * land and what is on disk is what a killed process would leave. A later dashboard starts cold.
 */
const fault = vi.hoisted(() => ({
  armed: false,
  remaining: Infinity,
  name: '',
  failOnce: false,
  dead: false,
  writes: [] as { path: string; bytes: string | Uint8Array }[],
}));
vi.mock('../../src/adapters/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/atomic.js')>();
  return {
    ...actual,
    async writeAtomic(path: string, bytes: string | Uint8Array) {
      if (fault.armed) {
        fault.writes.push({ path, bytes });
        const named = fault.name !== '' && path.endsWith(fault.name);
        if (named && fault.failOnce) {
          fault.name = '';
          throw new Error('simulated I/O failure');
        }
        if (fault.dead || named || fault.remaining-- <= 0) {
          fault.dead = true;
          throw new Error('simulated crash');
        }
      }
      await actual.writeAtomic(path, bytes);
    },
  };
});
vi.setConfig({ testTimeout: 600_000 });
afterEach(async () => {
  disarm();
  await cleanupFixtures();
});

function arm(options: { writes?: number; name?: string; failOnce?: boolean }) {
  Object.assign(fault, {
    armed: true,
    dead: false,
    remaining: options.writes ?? Infinity,
    name: options.name ?? '',
    failOnce: options.failOnce ?? false,
    writes: [],
  });
}
function disarm() {
  Object.assign(fault, { armed: false, dead: false, name: '', failOnce: false });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function journalPaths(source: string) {
  const root = join(source, '.git', 'repo-cloak-backups');
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.name === 'journal.json')
    .map((entry) => join(entry.parentPath, entry.name));
}

/** A push with a merge, a plain edit, a new file and a deletion. */
async function scenario() {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 20, 'cloak edit of Northwind'));
  const upstream = `${f.lines.map((line, at) => (at === 2 ? 'upstream edit of Acme' : line)).join('\n')}\n`;
  await writeFile(join(f.source, 'Acme.ts'), upstream);
  await f.edit('other.ts', 'class NorthwindOther { edit() {} }\n');
  await f.edit('NorthwindNew.ts', 'new Northwind\n');
  await rm(join(f.workspace, 'gone.ts'));
  const before: Record<string, string | null> = {
    'Acme.ts': upstream,
    'other.ts': 'class AcmeOther {}\n',
    'gone.ts': 'to be removed\n',
    'AcmeNew.ts': null,
  };
  const merged = `${f.lines
    .map((line, at) =>
      at === 2 ? 'upstream edit of Acme' : at === 20 ? 'cloak edit of Acme' : line,
    )
    .join('\n')}\n`;
  const after: Record<string, string | null> = {
    'Acme.ts': merged,
    'other.ts': 'class AcmeOther { edit() {} }\n',
    'gone.ts': null,
    'AcmeNew.ts': 'new Acme\n',
  };
  return { f, before, after };
}
const pushed = { confirmDeletes: ['gone.ts'] };
const pendingFiles = ['Northwind.ts', 'NorthwindNew.ts', 'gone.ts', 'other.ts'];
const sourceState = async (source: string) =>
  Object.fromEntries(
    await Promise.all(
      ['Acme.ts', 'other.ts', 'gone.ts', 'AcmeNew.ts'].map(async (name) => [
        name,
        await readFile(join(source, name), 'utf8').catch(() => null),
      ]),
    ),
  ) as Record<string, string | null>;
const recoveryChecks = (review: PushReview) =>
  review.checks.filter((check) => check.id.startsWith('recovery:'));
const filePaths = (review: PushReview) => review.files.map((file) => file.path).sort();
async function crashAt(f: Fixture, options: { writes?: number; name?: string }) {
  const opened = await f.reviewOf();
  arm(options);
  const done = await f.apply(opened.operationId, pushed);
  disarm();
  return done;
}

it('never leaves a mixed state, wherever the process dies', async () => {
  // How many durable writes a whole push makes, so every point can be visited.
  const probe = await scenario();
  expect((await crashAt(probe.f, {})).state).toBe('completed');
  const total = fault.writes.length;
  expect(total).toBeGreaterThan(5);
  expect(await sourceState(probe.f.source)).toEqual(probe.after);
  await cleanupFixtures();

  const seen = new Set<string>();
  for (let at = 0; at < total; at++) {
    const { f, before, after } = await scenario();
    await crashAt(f, { writes: at });
    await f.restart();
    const recovered = await f.reviewOf();
    const state = await sourceState(f.source);
    expect(await journalPaths(f.source), `journal left at write ${at}`).toEqual([]);
    const landed = JSON.stringify(state) === JSON.stringify(after);
    const untouched = JSON.stringify(state) === JSON.stringify(before);
    expect(landed || untouched, `mixed state at write ${at}: ${JSON.stringify(state)}`).toBe(true);
    seen.add(landed ? 'landed' : 'untouched');
    if (landed) {
      // Undo goes all the way back, including the merged file's upstream edit.
      expect(recovered.files).toEqual([]);
      const [backup] = await f.backups();
      expect(backup?.files).toBe(4);
      expect((await f.post(`/backups/${backup?.id}/undo`)).status).toBe(200);
      expect(await sourceState(f.source)).toEqual(before);
    } else {
      expect(await f.backups()).toEqual([]);
    }
    // Either way the edits are pending and can be pushed now.
    const again = await f.reviewOf();
    expect(filePaths(again)).toEqual(pendingFiles);
    expect((await f.apply(again.operationId, pushed)).state).toBe('completed');
    expect(await sourceState(f.source)).toEqual(after);
    await cleanupFixtures();
  }
  expect(seen).toEqual(new Set(['landed', 'untouched']));
});

it('writes a merged file once, with its merge, so there is no step between them', async () => {
  const { f, after } = await scenario();
  await crashAt(f, {});
  const target = join(f.source, 'Acme.ts');
  const writes = fault.writes.filter((write) => write.path === target);
  expect(writes).toHaveLength(1);
  expect(Buffer.from(writes[0]?.bytes ?? '').toString('utf8')).toBe(after['Acme.ts']);
});

it('rolls back a partial write, restoring the upstream edit and leaving edits pending', async () => {
  const { f, before } = await scenario();
  await crashAt(f, { name: 'other.ts' });
  const [journal] = await journalPaths(f.source);
  expect(journal).toBeDefined();
  expect(await sourceState(f.source)).not.toEqual(before);
  // A real kill strands writeAtomic's temporary next to its target; a user's file is not touched.
  const stranded = join(f.source, `.cloak-${crypto.randomUUID()}.tmp`);
  await writeFile(stranded, 'real bytes');
  await writeFile(join(f.source, '.cloak-mine.tmp'), 'not ours');

  await f.restart();
  const review = await f.reviewOf();
  expect(recoveryChecks(review)).toMatchObject([
    { state: 'warning', title: 'An interrupted push was rolled back' },
  ]);
  expect(await sourceState(f.source)).toEqual(before);
  await expect(readFile(stranded)).rejects.toThrow();
  expect(await readFile(join(f.source, '.cloak-mine.tmp'), 'utf8')).toBe('not ours');
  await rm(join(f.source, '.cloak-mine.tmp'));
  await expect(readdir(dirname(journal ?? ''))).rejects.toThrow();
  expect(filePaths(review)).toEqual(pendingFiles);
  expect(review.canApply).toBe(true);
  const events = (await f.dashboard.sync.audit.list()).events;
  expect(
    events.some((event) => event.detail === 'Recovery: An interrupted push was rolled back'),
  ).toBe(true);
  // The note stays until the next push clears it.
  const next = await f.reviewOf();
  expect(recoveryChecks(next)).toHaveLength(1);
  await f.apply(next.operationId, pushed);
  expect(recoveryChecks(await f.reviewOf())).toEqual([]);
});

it('touches nothing, and keeps copies as a backup, when something else changed a file', async () => {
  const { f, before } = await scenario();
  await crashAt(f, { name: 'other.ts' });
  await writeFile(join(f.source, 'other.ts'), 'someone else\n');
  await f.restart();
  const review = await f.reviewOf();
  expect(recoveryChecks(review)).toMatchObject([
    { state: 'warning', title: 'An interrupted push needs your attention' },
  ]);
  expect(recoveryChecks(review)[0]?.detail).toContain('other.ts changed afterwards');
  expect(await readFile(join(f.source, 'other.ts'), 'utf8')).toBe('someone else\n');
  expect(await journalPaths(f.source)).toEqual([]);
  const [backup] = await f.backups();
  expect((await f.post(`/backups/${backup?.id}/undo`)).status).toBe(200);
  expect(await sourceState(f.source)).toEqual(before);
});

it('offers undo for a push that landed but stopped before finishing, and clears the index', async () => {
  const { f, before, after } = await scenario();
  const done = await crashAt(f, { name: 'index.json' });
  expect(done.state).toBe('completed');
  expect(done.result?.warnings.join()).toContain('Undo is not available yet');
  expect(await sourceState(f.source)).toEqual(after);
  expect(await journalPaths(f.source)).toHaveLength(1);
  // As if the crash fell between the workspace's add and commit.
  await f.edit('other.ts', 'class NorthwindOther { edit() {} }\n');
  await f.git(f.workspace, 'add', '-f', '.repo-cloak/manifest.json');

  await f.restart();
  const review = await f.reviewOf();
  expect(recoveryChecks(review)).toMatchObject([
    { state: 'warning', title: 'An interrupted push had landed' },
  ]);
  expect(await sourceState(f.source)).toEqual(after);
  expect(await f.git(f.workspace, 'diff', '--cached', '--name-only')).toBe('');
  const [backup] = await f.backups();
  expect((await f.post(`/backups/${backup?.id}/undo`)).status).toBe(200);
  expect(await sourceState(f.source)).toEqual(before);
});

it('waits rather than recovers while the locks are held', async () => {
  const { f } = await scenario();
  await crashAt(f, { name: 'other.ts' });
  await f.restart();
  const release = await lock(f.workspace, { retries: 0 });
  const state = await sourceState(f.source);
  try {
    const review = await f.reviewOf();
    expect(recoveryChecks(review)).toMatchObject([{ id: 'recovery:pending', state: 'blocked' }]);
    expect(review.operationId).toBeNull();
    expect(review.canApply).toBe(false);
    expect(await sourceState(f.source)).toEqual(state);
    expect(await journalPaths(f.source)).toHaveLength(1);
    const refused = await f.post(`/backups/${crypto.randomUUID()}/undo`);
    expect(refused.status).toBe(409);
  } finally {
    await release();
  }
  expect(recoveryChecks(await f.reviewOf())[0]?.title).toBe('An interrupted push was rolled back');
});

it('reports a damaged journal without rolling back or blocking forever', async () => {
  const { f } = await scenario();
  await crashAt(f, { name: 'other.ts' });
  const [journal = ''] = await journalPaths(f.source);
  await writeFile(journal, '{"kind":"push-backup","sealed":{}}');
  const state = await sourceState(f.source);
  await f.restart();
  const review = await f.reviewOf();
  expect(recoveryChecks(review)).toMatchObject([
    { state: 'warning', title: 'An interrupted push could not be read' },
  ]);
  expect(await sourceState(f.source)).toEqual(state);
  expect(await readdir(dirname(journal))).toContain('journal.unreadable');
  expect(await journalPaths(f.source)).toEqual([]);
  expect(review.operationId).not.toBeNull();
});

it('names the leftover worktree when a new-worktree push was interrupted', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  const opened = await f.reviewOf({ kind: 'new-worktree', branch: 'interrupted' });
  arm({ name: '.repo-cloak/manifest.json' });
  await f.apply(opened.operationId);
  disarm();
  await f.restart();
  const check = recoveryChecks(await f.reviewOf())[0];
  expect(check?.title).toBe('An interrupted push left a worktree behind');
  expect(check?.detail).toContain(basename(f.source));
  expect((await f.reviewOf()).files.map((file) => file.path)).toEqual(['Northwind.ts']);
  expect(await f.read('Acme.ts')).not.toContain('edit');
});

it('refuses a review opened before the crash, until recovery has run', async () => {
  const { f, before } = await scenario();
  const oldBase = f.base;
  const oldDashboard = f.dashboard;
  const opened = await f.reviewOf();
  await f.restart();
  await crashAt(f, { name: 'other.ts' });
  const response = await fetch(`${oldBase}/apply`, {
    method: 'POST',
    headers: f.headers,
    body: JSON.stringify({
      operationId: opened.operationId,
      mode: 'write',
      repull: false,
      includeGroupMembers: false,
      mergeMode: 'merge',
      ...pushed,
    }),
  });
  const started = (await response.json()) as OperationState;
  const done = await oldDashboard.sync.wait(started.operationId);
  expect(done.state).toBe('failed');
  expect(done.error).toContain('interrupted');
  expect(await journalPaths(f.source)).toHaveLength(1);
  await f.reviewOf();
  expect(await sourceState(f.source)).toEqual(before);
});

it('rolls back on an ordinary write failure, keeping no backup and no journal', async () => {
  const { f, before } = await scenario();
  const opened = await f.reviewOf();
  arm({ name: 'Acme.ts', failOnce: true });
  const done = await f.apply(opened.operationId, pushed);
  disarm();
  expect(done.state).toBe('failed');
  expect(await sourceState(f.source)).toEqual(before);
  expect(await journalPaths(f.source)).toEqual([]);
  expect(await f.backups()).toEqual([]);
  expect(recoveryChecks(await f.reviewOf())).toEqual([]);
});

it('keeps undo when only the store record could not be updated afterwards', async () => {
  const { f, before, after } = await scenario();
  const opened = await f.reviewOf();
  arm({ name: 'repo.json', failOnce: true });
  const done = await f.apply(opened.operationId, pushed);
  disarm();
  expect(done.state).toBe('failed');
  expect(done.error).toContain('updating the local store failed');
  expect(await sourceState(f.source)).toEqual(after);
  expect(await journalPaths(f.source)).toEqual([]);
  const [backup] = await f.backups();
  expect((await f.post(`/backups/${backup?.id}/undo`)).status).toBe(200);
  expect(await sourceState(f.source)).toEqual(before);
});

it('can finish an undo that was interrupted part way', async () => {
  const { f, before, after } = await scenario();
  await crashAt(f, {});
  expect(await sourceState(f.source)).toEqual(after);
  const [backup] = await f.backups();
  arm({ name: 'manifest.json' });
  const stopped = await f.post(`/backups/${backup?.id}/undo`);
  disarm();
  expect(stopped.ok).toBe(false);
  expect(await sourceState(f.source)).toEqual(before);
  await f.restart();
  expect((await f.post(`/backups/${backup?.id}/undo`)).status).toBe(200);
  expect(await sourceState(f.source)).toEqual(before);
  expect(await f.backups()).toEqual([]);
});
