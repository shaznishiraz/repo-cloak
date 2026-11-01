import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backupRoot,
  readBackups,
  readBytes,
  readPart,
  sealManifestCopy,
  writePart,
} from '../../src/adapters/server-v2/push/backups.js';
import { hashBytes } from '../../src/core/hash.js';
import type { PushReview } from '../../src/web/api/contracts.js';
import { cleanupFixtures, editedLines, fixture, secret } from '../support/push-fixture.js';

// Each test drives real Git through several previews.
vi.setConfig({ testTimeout: 60_000 });
const exec = promisify(execFile);
afterEach(cleanupFixtures);

it('lists file changes with flags and passes the guard checks', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 10, 'edited line'));
  await f.edit('NorthwindExportJob.ts', 'export class NorthwindExportJob {}\n');
  await rm(join(f.workspace, 'gone.ts'));
  const review = await f.reviewOf();
  expect(review.canApply).toBe(true);
  expect(review.operationId).toEqual(expect.any(String));
  const byPath = new Map(review.files.map((file) => [file.path, file]));
  expect(byPath.get('Northwind.ts')).toMatchObject({
    restoredPath: 'Acme.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    flags: ['clean'],
  });
  expect(byPath.get('NorthwindExportJob.ts')).toMatchObject({
    restoredPath: 'AcmeExportJob.ts',
    status: 'added',
    flags: expect.arrayContaining(['new-derived-name']),
  });
  expect(byPath.get('gone.ts')?.status).toBe('deleted');
  expect(review.derivedNames).toContainEqual({
    cloaked: 'NorthwindExportJob',
    restored: 'AcmeExportJob',
  });
  const checks = new Map(review.checks.map((check) => [check.id, check]));
  expect(checks.get('restores')).toMatchObject({ state: 'ok' });
  expect(checks.get('no-leak')).toMatchObject({ state: 'ok' });
  expect(checks.get('merges')).toMatchObject({ state: 'ok' });
  expect(checks.get('manifest')).toMatchObject({ state: 'ok' });
  expect(checks.get('target')?.title).toBe('target is clean');
  // Reviewing writes nothing.
  expect(await f.read('Acme.ts')).toContain('line 11 of Acme');
});

it('shows the cloak and the restored line side by side, without real secrets', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 10, 'const client = "Northwind client";'));
  const lines = await f.diffOf('Northwind.ts');
  expect(lines.find((line) => line.kind === 'add')).toEqual({
    kind: 'add',
    line: 11,
    cloaked: 'const client = "Northwind client";',
    restored: 'const client = "Acme client";',
  });
  expect(lines.find((line) => line.kind === 'remove')).toMatchObject({
    line: 11,
    cloaked: 'line 11 of Northwind',
    restored: 'line 11 of Acme',
  });
  // Three lines of context either side, not the whole file.
  expect(lines).toHaveLength(8);

  const keys = await readFile(join(f.workspace, 'keys.ts'), 'utf8');
  await f.edit('keys.ts', keys.replace('name = "Northwind"', 'name = "Northwind Ltd"'));
  const masked = await f.diffOf('keys.ts');
  expect(JSON.stringify(masked)).not.toContain(secret);
  expect(masked.find((line) => line.kind === 'add')?.restored).toBe('const name = "Acme Ltd";');
  expect(masked.map((line) => line.restored)).toContain('const key = "[secret]";');

  const refused = await fetch(`${f.base}/diff?path=${encodeURIComponent('other.ts')}`, {
    headers: f.headers,
  });
  expect(refused.status).toBe(404);
  const escaped = await fetch(`${f.base}/diff?path=${encodeURIComponent('../secret')}`, {
    headers: f.headers,
  });
  expect(escaped.status).toBe(400);
});

it('builds the diff from the source when the workspace has no Git history', async () => {
  const f = await fixture(false);
  await f.edit('Northwind.ts', editedLines(f.lines, 2, 'changed'));
  const lines = await f.diffOf('Northwind.ts');
  expect(lines.filter((line) => line.kind !== 'context').map((line) => line.line)).toEqual([3, 3]);
  expect((await f.reviewOf()).files[0]).toMatchObject({ additions: 1, deletions: 1 });
});

it('auto-merges a moved source when the edits do not overlap', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 20, 'cloak edit of Northwind'));
  const upstream = f.lines.map((line, index) => (index === 2 ? 'upstream edit of Acme' : line));
  await writeFile(join(f.source, 'Acme.ts'), `${upstream.join('\n')}\n`);
  await f.git(f.source, 'commit', '-am', 'upstream');
  const head = (await f.git(f.source, 'rev-parse', '--short', 'HEAD')).trim();
  const review = await f.reviewOf();
  expect(review.files[0]?.flags).toEqual(expect.arrayContaining(['source-moved', 'auto-merge']));
  const note = review.checks.find((check) => check.id === 'merge:Northwind.ts');
  expect(note).toMatchObject({ state: 'info' });
  expect(note?.detail).toContain(head);
  expect(note?.detail).toContain('line 3');
  expect(note?.detail).toContain('line 21');
  expect(review.checks.find((check) => check.id === 'merges')?.state).toBe('info');
  expect(review.checks.find((check) => check.id === 'target')?.detail).toContain(
    '1 new upstream commit',
  );
  const done = await f.apply(review.operationId);
  expect(done.state).toBe('completed');
  const merged = await f.read('Acme.ts');
  expect(merged).toContain('upstream edit of Acme');
  expect(merged).toContain('cloak edit of Acme');
  expect(merged).not.toContain('Northwind');
});

it('blocks overlapping edits unless overwrite is chosen, and overwrite is reversible', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 5, 'cloak side'));
  const upstream = `${f.lines.map((line, index) => (index === 5 ? 'upstream side' : line)).join('\n')}\n`;
  await writeFile(join(f.source, 'Acme.ts'), upstream);
  const review = await f.reviewOf();
  expect(review.files[0]?.flags).toEqual(expect.arrayContaining(['source-moved', 'conflict']));
  expect(review.checks.find((check) => check.id === 'merges')?.state).toBe('blocked');
  await expect(f.apply(review.operationId)).rejects.toThrow(/overlap upstream/);
  expect(await f.read('Acme.ts')).toBe(upstream);
  // A refused apply keeps the review alive for a different choice.
  const done = await f.apply(review.operationId, {
    mergeMode: 'overwrite',
    confirmOverwrites: ['Acme.ts'],
  });
  expect(done.state).toBe('completed');
  expect(await f.read('Acme.ts')).toContain('cloak side');
  const [backup] = await f.backups();
  expect(backup?.files).toBe(1);
  const undone = await f.post(`/backups/${backup?.id}/undo`);
  expect(await undone.json()).toEqual({ restored: 1 });
  expect(await f.read('Acme.ts')).toBe(upstream);
});

it('refuses a cloaked name that cannot restore and a damaged placeholder', async () => {
  const f = await fixture();
  await f.edit('keys.ts', 'const key = "REDACTED_NOT_A_REAL_ONE";\n');
  const review = await f.reviewOf();
  expect(review.canApply).toBe(false);
  expect(review.operationId).toBeNull();
  const restores = review.checks.find((check) => check.id === 'restores');
  expect(restores?.state).toBe('blocked');
  expect(restores?.detail).toContain('keys.ts');
  expect(await f.read('keys.ts')).toContain(secret);
});

it('holds back new files that exclusions keep out of the source', async () => {
  const f = await fixture();
  await f.dashboard.sync.saveExclusions(f.repoId, { patterns: ['*.secret'] });
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.edit('notes.secret', 'private');
  const review = await f.reviewOf();
  expect(review.files.map((file) => file.path)).toEqual(['Northwind.ts']);
  const manifest = review.checks.find((check) => check.id === 'manifest');
  expect(manifest?.state).toBe('warning');
  expect(manifest?.detail).toContain('notes.secret');
  await f.apply(review.operationId);
  await expect(f.read('notes.secret')).rejects.toThrow();
});

it('writes only, stages, or commits with the message restored', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'one'));
  await f.apply((await f.reviewOf()).operationId);
  expect(await f.git(f.source, 'diff', '--cached', '--name-only')).toBe('');
  expect(await f.git(f.source, 'diff', '--name-only')).toBe('Acme.ts');

  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'two'));
  await f.apply((await f.reviewOf()).operationId, { mode: 'stage' });
  expect(await f.git(f.source, 'diff', '--cached', '--name-only')).toBe('Acme.ts');

  await writeFile(join(f.source, 'unrelated.txt'), 'staged by the user');
  await f.git(f.source, 'add', 'unrelated.txt');
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'three'));
  const done = await f.apply((await f.reviewOf()).operationId, {
    mode: 'commit',
    commitMessage: 'Add NorthwindExportJob for Northwind',
  });
  expect(done.result?.warnings.join()).toContain('Committed');
  expect(await f.git(f.source, 'log', '-1', '--format=%s')).toBe('Add AcmeExportJob for Acme');
  expect(await f.git(f.source, 'show', '--name-only', '--format=', 'HEAD')).toBe('Acme.ts');
  // Only this push is in the commit; what the user had staged stays staged.
  expect(await f.git(f.source, 'diff', '--cached', '--name-only')).toBe('unrelated.txt');
});

it('rejects a commit without a message, or with a secret placeholder in it', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'one'));
  const review = await f.reviewOf();
  await expect(f.apply(review.operationId, { mode: 'commit' })).rejects.toThrow(/commit message/i);
  const keys = await readFile(join(f.workspace, 'keys.ts'), 'utf8');
  const placeholder = /REDACTED_[A-Za-z0-9_-]*/.exec(keys)?.[0] ?? '';
  expect(placeholder).not.toBe('');
  await expect(
    f.apply(review.operationId, { mode: 'commit', commitMessage: `use ${placeholder}` }),
  ).rejects.toThrow(/secret/);
  expect((await f.apply(review.operationId, {})).state).toBe('completed');
});

it('reports a failed commit as a warning, with the files still pushed', async () => {
  const f = await fixture();
  const hooks = join(f.root, 'hooks');
  await mkdir(hooks);
  await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\necho "rejected by hook" >&2\nexit 1\n');
  await chmod(join(hooks, 'pre-commit'), 0o755);
  await f.git(f.source, 'config', 'core.hooksPath', hooks);
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'one'));
  const done = await f.apply((await f.reviewOf()).operationId, {
    mode: 'commit',
    commitMessage: 'message',
  });
  expect(done.state).toBe('completed');
  expect(done.result?.warnings.join()).toContain('committing failed');
  expect(await f.read('Acme.ts')).toContain('one');
});

it('re-pulls after a push so the cloak carries merged upstream lines', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 20, 'cloak edit'));
  const upstream = f.lines.map((line, index) => (index === 2 ? 'upstream of Acme' : line));
  await writeFile(join(f.source, 'Acme.ts'), `${upstream.join('\n')}\n`);
  const done = await f.apply((await f.reviewOf()).operationId, { repull: true });
  expect(done.state).toBe('completed');
  expect(done.result?.warnings.join()).not.toContain('re-pull failed');
  const cloak = await readFile(join(f.workspace, 'Northwind.ts'), 'utf8');
  expect(cloak).toContain('upstream of Northwind');
  expect(cloak).toContain('cloak edit');
  expect((await f.reviewOf()).files).toEqual([]);
});

it('keeps a backup, lists it for 7 days, and undoes the push and its baseline', async () => {
  const f = await fixture();
  const before = await f.read('Acme.ts');
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.edit('Northwind2.ts', 'new file\n');
  await rm(join(f.workspace, 'gone.ts'));
  const review = await f.reviewOf();
  expect((await f.apply(review.operationId, { confirmDeletes: ['gone.ts'] })).state).toBe(
    'completed',
  );
  await expect(f.read('gone.ts')).rejects.toThrow();
  const backups = await f.backups();
  expect(backups).toHaveLength(1);
  const backup = backups[0];
  expect(backup?.files).toBe(3);
  const days =
    (Date.parse(backup?.expiresAt ?? '') - Date.parse(backup?.createdAt ?? '')) / 86400000;
  expect(days).toBe(7);
  expect((await f.reviewOf()).files).toEqual([]);

  const undone = await f.post(`/backups/${backup?.id}/undo`);
  expect(undone.status).toBe(200);
  expect(await undone.json()).toEqual({ restored: 3 });
  expect(await f.read('Acme.ts')).toBe(before);
  expect(await f.read('gone.ts')).toBe('to be removed\n');
  await expect(f.read('Acme2.ts')).rejects.toThrow();
  // The edits are pending again, so nothing was lost.
  expect((await f.reviewOf()).files.map((file) => file.path).sort()).toEqual([
    'Northwind.ts',
    'Northwind2.ts',
    'gone.ts',
  ]);
  expect(await f.backups()).toEqual([]);
  const again = await f.post(`/backups/${backup?.id}/undo`);
  expect(again.status).toBe(404);
  const events = (await f.dashboard.sync.audit.list()).events;
  expect(events.some((event) => event.detail?.includes('Undid'))).toBe(true);
});

it('stores backups in the source Git directory, not the cloak', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.apply((await f.reviewOf()).operationId);
  const inCloak = await exec('grep', ['-r', '-l', 'line 2 of Acme', f.workspace]).catch(
    () => undefined,
  );
  expect(inCloak).toBeUndefined();
  const [backup] = await f.backups();
  expect(backup?.files).toBe(1);
  const parts = await backupParts(f.source);
  expect(parts.map((part) => basename(part)).sort()).toEqual([
    'f0.json',
    'index.json',
    'manifest.json',
  ]);
});

async function backupParts(source: string) {
  const root = join(source, '.git', 'repo-cloak-backups');
  const found = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return found.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

it('seals backups: no source text, path or root is readable on disk', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  const keys = await readFile(join(f.workspace, 'keys.ts'), 'utf8');
  await f.edit('keys.ts', keys.replace('name = "Northwind"', 'name = "x"'));
  await f.apply((await f.reviewOf()).operationId);
  const parts = await backupParts(f.source);
  expect(parts.length).toBeGreaterThan(2);
  for (const part of parts) {
    const text = await readFile(part, 'utf8');
    for (const leak of ['Acme', 'line 2 of', secret, f.root, 'keys.ts', 'manifestAfter'])
      expect(text).not.toContain(leak);
    expect(JSON.parse(text)).toMatchObject({
      kind: 'push-backup',
      sealed: { alg: 'A256GCM' },
    });
  }
  // grep over the whole Git directory finds none of the old source text in a backup.
  const hits = await exec('grep', [
    '-r',
    '-l',
    secret,
    join(f.source, '.git', 'repo-cloak-backups'),
  ])
    .then(({ stdout }) => stdout)
    .catch(() => '');
  expect(hits).toBe('');
});

it('undoes from sealed backups, and refuses a tampered or swapped part', async () => {
  const f = await fixture();
  const before = await f.read('Acme.ts');
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.apply((await f.reviewOf()).operationId);
  const [backup] = await f.backups();
  const parts = await backupParts(f.source);
  const blob = parts.find((part) => part.endsWith('f0.json')) ?? '';
  const good = await readFile(blob, 'utf8');
  const value = JSON.parse(good) as { sealed: { data: string } };
  const data = Buffer.from(value.sealed.data, 'base64');
  data[0] = (data[0] ?? 0) ^ 0xff;
  value.sealed.data = data.toString('base64');
  await writeFile(blob, JSON.stringify(value));
  const pushed = await f.read('Acme.ts');
  const tampered = await f.post(`/backups/${backup?.id}/undo`);
  expect(tampered.ok).toBe(false);
  expect(await f.read('Acme.ts')).toBe(pushed);
  // The same bytes under another part's name fail as well: the name is authenticated.
  const manifestPart = parts.find((part) => part.endsWith('manifest.json')) ?? '';
  const manifestText = await readFile(manifestPart, 'utf8');
  await writeFile(manifestPart, good);
  await writeFile(blob, manifestText);
  expect((await f.post(`/backups/${backup?.id}/undo`)).ok).toBe(false);
  expect(await f.read('Acme.ts')).toBe(pushed);
  await writeFile(blob, good);
  await writeFile(manifestPart, manifestText);
  expect(await (await f.post(`/backups/${backup?.id}/undo`)).json()).toEqual({ restored: 1 });
  expect(await f.read('Acme.ts')).toBe(before);
});

it('seals a plaintext backup from before this change, keeping undo, and removes the plaintext', async () => {
  const f = await fixture();
  const before = await f.read('Acme.ts');
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.apply((await f.reviewOf()).operationId);
  const [backup] = await f.backups();
  const parts = await backupParts(f.source);
  const directory = dirname(parts[0] ?? '');
  // Rebuild the old on-disk format from the sealed parts.
  const vault = await f.dashboard.sync.vault();
  const id = backup?.id ?? '';
  const index = (await readPart(vault, directory, id, 'index')) as object;
  await writeFile(join(directory, 'f0'), await readBytes(vault, directory, id, 'f0'));
  await writeFile(
    join(directory, 'manifest'),
    sealManifestCopy(vault, await readPart(vault, directory, id, 'manifest')),
  );
  await rm(join(directory, 'f0.json'));
  await rm(join(directory, 'manifest.json'));
  await writeFile(
    join(directory, 'index.json'),
    JSON.stringify({
      ...index,
      manifestAfter: hashBytes(await readFile(join(f.workspace, '.repo-cloak', 'manifest.json'))),
    }),
  );
  expect(await readFile(join(directory, 'f0'), 'utf8')).toContain('line 2 of Acme');

  expect((await f.backups()).map((item) => item.id)).toEqual([id]);
  const after = await readdir(directory);
  expect(after.sort()).toEqual(['f0.json', 'index.json', 'manifest.json']);
  expect(await readFile(join(directory, 'index.json'), 'utf8')).not.toContain(f.root);

  // A crash after the commit point leaves plaintext, which the next read removes.
  await writeFile(join(directory, 'f0'), 'leftover plaintext');
  await f.backups();
  expect(await readdir(directory)).not.toContain('f0');

  expect(await (await f.post(`/backups/${id}/undo`)).json()).toEqual({ restored: 1 });
  expect(await f.read('Acme.ts')).toBe(before);
});

it('keeps undo working across a key rotation', async () => {
  const f = await fixture();
  const before = await f.read('Acme.ts');
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.apply((await f.reviewOf()).operationId);
  const [backup] = await f.backups();
  const part = (await backupParts(f.source)).find((item) => item.endsWith('f0.json')) ?? '';
  const oldKey = (JSON.parse(await readFile(part, 'utf8')) as { sealed: { keyId: string } }).sealed
    .keyId;
  const rotated = await f.dashboard.security.rotateKey();
  expect(rotated.pending).toEqual([]);
  const newKey = (JSON.parse(await readFile(part, 'utf8')) as { sealed: { keyId: string } }).sealed
    .keyId;
  expect(newKey).not.toBe(oldKey);
  expect(newKey).toBe(rotated.keyId);
  expect(await (await f.post(`/backups/${backup?.id}/undo`)).json()).toEqual({ restored: 1 });
  expect(await f.read('Acme.ts')).toBe(before);
  // The restored manifest is sealed under the new key, so the workspace still opens.
  expect((await f.reviewOf()).files.map((file) => file.path)).toEqual(['Northwind.ts']);
});

it('bounds retention by count and size, keeping the newest', async () => {
  const f = await fixture();
  const vault = await f.dashboard.sync.vault();
  const commonDir = join(f.source, '.git');
  const { base, relative } = backupRoot(commonDir, f.workspaceId);
  const parent = join(base, relative);
  const make = async (age: number, bytes = 0) => {
    const id = crypto.randomUUID();
    const directory = join(parent, id);
    const createdAt = new Date(Date.now() - age);
    await writePart(vault, directory, id, 'index', {
      id,
      workspaceId: f.workspaceId,
      root: f.source,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 7 * 86400000).toISOString(),
      manifestAfter: 'x',
      files: [],
    });
    if (bytes) await writeFile(join(directory, 'f0.json'), Buffer.alloc(bytes));
    return id;
  };
  const ids: string[] = [];
  for (let at = 0; at < 22; at++) ids.push(await make(at * 1000));
  const kept = await readBackups(vault, commonDir, f.workspaceId);
  expect(kept.map((item) => item.id)).toEqual(ids.slice(0, 20));
  expect((await readdir(parent)).length).toBe(20);
  await rm(parent, { recursive: true });

  // Too large together: the oldest goes. The newest stays even if it alone is over the limit.
  const big = 150 * 1024 * 1024;
  const [newest, older] = [await make(0, big), await make(1000, big)];
  expect((await readBackups(vault, commonDir, f.workspaceId)).map((item) => item.id)).toEqual([
    newest,
  ]);
  await expect(readdir(join(parent, older))).rejects.toThrow();
  await rm(parent, { recursive: true });
  const huge = await make(0, 300 * 1024 * 1024);
  expect((await readBackups(vault, commonDir, f.workspaceId)).map((item) => item.id)).toEqual([
    huge,
  ]);
  await rm(parent, { recursive: true });
});

it('ages out the backups of other workspaces, without their key', async () => {
  const f = await fixture();
  const root = join(f.source, '.git', 'repo-cloak-backups');
  const old = join(root, 'deleted-workspace', crypto.randomUUID());
  const recent = join(root, 'other-workspace', crypto.randomUUID());
  await mkdir(old, { recursive: true });
  await mkdir(recent, { recursive: true });
  await writeFile(join(old, 'f0.json'), '{}');
  const past = new Date(Date.now() - 8 * 86400000);
  await utimes(old, past, past);
  await f.backups();
  await expect(readdir(join(root, 'deleted-workspace'))).rejects.toThrow();
  expect(await readdir(join(root, 'other-workspace'))).toHaveLength(1);
});

it('refuses to undo over newer work', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.apply((await f.reviewOf()).operationId);
  const [backup] = await f.backups();
  await writeFile(join(f.source, 'Acme.ts'), 'someone kept working');
  const refused = await f.post(`/backups/${backup?.id}/undo`);
  expect(refused.status).toBe(409);
  expect(await f.read('Acme.ts')).toBe('someone kept working');
  expect(await f.backups()).toHaveLength(1);
});

it('removes backups once they expire', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.apply((await f.reviewOf()).operationId);
  const [backup] = await f.backups();
  const later = Date.now() + 8 * 86400000;
  const realNow = Date.now;
  Date.now = () => later;
  try {
    expect(await f.backups()).toEqual([]);
  } finally {
    Date.now = realNow;
  }
  expect((await f.post(`/backups/${backup?.id}/undo`)).status).toBe(404);
});

it('targets main, another worktree, a new worktree, and a read-only dry run', async () => {
  const f = await fixture();
  const other = join(f.root, 'other');
  await f.git(f.source, 'worktree', 'add', '-b', 'other', other);
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'target edit'));

  const dry = await f.reviewOf({ kind: 'dry-run' });
  expect(dry.operationId).toBeNull();
  expect(dry.canApply).toBe(false);
  expect(dry.files).toHaveLength(1);

  const fresh = await f.reviewOf({ kind: 'new-worktree', branch: 'feature/new' });
  expect(fresh.canApply).toBe(true);
  expect(fresh.checks.find((check) => check.id === 'target')?.title).toContain('new worktree');

  const review = await f.reviewOf({ kind: 'worktree', path: other });
  expect(review.canApply).toBe(true);
  await f.apply(review.operationId);
  expect(await f.read('Acme.ts', other)).toContain('target edit');
  expect(await f.read('Acme.ts')).not.toContain('target edit');

  const outsider = await f.post('/review', { target: { kind: 'worktree', path: f.root } });
  expect(outsider.status).toBe(400);
});

it('pushes a new worktree from main without a backup', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  const review = await f.reviewOf({ kind: 'new-worktree', branch: 'from-main' });
  const done = await f.apply(review.operationId);
  expect(done.state).toBe('completed');
  expect(await f.git(f.source, 'branch', '--list', 'from-main')).toContain('from-main');
  expect(await f.backups()).toEqual([]);
});

it('includes group members only when they are safe to push unreviewed', async () => {
  const f = await fixture();
  const secondSource = join(f.root, 'second');
  const secondCloak = join(f.root, 'second-cloak');
  await mkdir(secondSource);
  await f.git(secondSource, 'init', '-b', 'main');
  await writeFile(join(secondSource, 'Acme.web'), 'web of Acme\n');
  await f.git(secondSource, 'add', '-A');
  await f.git(secondSource, 'commit', '-m', 'initial');
  const { dashboard } = f;
  const secondRepo = await dashboard.addRepository({ path: secondSource });
  const [profile] = await dashboard.profiles();
  const created = await dashboard.sync.preview({
    intent: 'create',
    repoId: secondRepo.repoId,
    worktree: secondSource,
    destination: secondCloak,
    profiles: [{ id: profile?.id ?? '', scope: { kind: 'global' } }],
    files: ['Acme.web'],
  });
  await dashboard.sync.apply(created.operationId, {});
  const done = await dashboard.sync.wait(created.operationId);
  const secondId = done.result?.workspaceId ?? '';
  await dashboard.groups.save({
    name: 'claims',
    members: [
      { repoId: f.repoId, workspaceId: f.workspaceId, worktree: f.source },
      { repoId: secondRepo.repoId, workspaceId: secondId, worktree: secondSource },
    ],
  });
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  await f.edit('Northwind.web', 'member edit of Northwind\n', secondCloak);

  // Left out unless it is asked for.
  await f.apply((await f.reviewOf()).operationId);
  expect(await f.read('Acme.web', secondSource)).toBe('web of Acme\n');

  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit again'));
  const pushed = await f.apply((await f.reviewOf()).operationId, {
    includeGroupMembers: true,
    mode: 'commit',
    commitMessage: 'Sync Northwind',
  });
  expect(pushed.result?.warnings.join()).toContain('second-cloak: 1 files pushed');
  expect(await f.read('Acme.web', secondSource)).toBe('member edit of Acme\n');
  expect(await f.git(secondSource, 'log', '-1', '--format=%s')).toBe('Sync Acme');

  // A member whose source moved waits for its own review.
  await f.edit('Northwind.web', 'second edit\n', secondCloak);
  await writeFile(join(secondSource, 'Acme.web'), 'moved upstream\n');
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'third'));
  const held = await f.apply((await f.reviewOf()).operationId, { includeGroupMembers: true });
  expect(held.state).toBe('completed');
  expect(held.result?.warnings.join()).toContain('second-cloak: not pushed');
  expect(await f.read('Acme.web', secondSource)).toBe('moved upstream\n');
});

it('invalidates the review when the source changes, and replaces older reviews', async () => {
  const f = await fixture();
  await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit'));
  const first = await f.reviewOf();
  const second = await f.reviewOf();
  expect(second.operationId).not.toBe(first.operationId);
  await expect(f.apply(first.operationId)).rejects.toThrow(/review the push again/);
  await writeFile(join(f.source, 'other.ts'), 'moved after review\n');
  const stale = await f.apply(second.operationId);
  expect(stale.state).toBe('failed');
  expect(stale.code).toBe('stale');
  expect(await f.read('Acme.ts')).not.toContain('edit');
  expect(await f.backups()).toEqual([]);
});

it('validates every body, query and identifier', async () => {
  const f = await fixture();
  const invalid = [
    await f.post('/review', {}),
    await f.post('/review', { target: { kind: 'nowhere' } }),
    await f.post('/review', { target: { kind: 'origin', extra: true } }),
    await f.post('/review', { target: { kind: 'new-worktree', branch: '' } }),
    await f.post('/apply', { operationId: 'not-a-uuid' }),
    await f.post('/apply', {
      operationId: crypto.randomUUID(),
      mode: 'rm -rf',
      repull: false,
      includeGroupMembers: false,
      mergeMode: 'merge',
    }),
    await f.post('/backups/not-a-uuid/undo'),
    await fetch(`${f.base}/diff`, { headers: f.headers }),
    await fetch(`${f.base.replace(f.repoId, 'nothex')}/backups`, { headers: f.headers }),
  ];
  for (const response of invalid) expect(response.status).toBe(400);
  const unknown = await f.post('/apply', {
    operationId: crypto.randomUUID(),
    mode: 'write',
    repull: false,
    includeGroupMembers: false,
    mergeMode: 'merge',
  });
  expect(unknown.status).toBe(404);
  const anonymous = await fetch(`${f.base}/backups`);
  expect(anonymous.status).toBe(401);
});

describe('acknowledgements are enforced by the server', () => {
  it('refuses a deletion without its exact confirmation, then accepts it', async () => {
    const f = await fixture();
    await rm(join(f.workspace, 'gone.ts'));
    const review = await f.reviewOf();
    await expect(f.apply(review.operationId)).rejects.toThrow(/Confirm the listed deletions/);
    await expect(f.apply(review.operationId, { confirmDeletes: [] })).rejects.toThrow(/Confirm/);
    await expect(f.apply(review.operationId, { confirmDeletes: ['other.ts'] })).rejects.toThrow(
      /Confirm/,
    );
    expect(await f.read('gone.ts')).toBe('to be removed\n');
    expect(await f.backups()).toEqual([]);
    const done = await f.apply(review.operationId, { confirmDeletes: ['gone.ts'] });
    expect(done.state).toBe('completed');
    await expect(f.read('gone.ts')).rejects.toThrow();
  });

  it('refuses an overwrite without its exact confirmation', async () => {
    const f = await fixture();
    await f.edit('Northwind.ts', editedLines(f.lines, 5, 'cloak side'));
    const upstream = `${f.lines.map((line, index) => (index === 5 ? 'upstream side' : line)).join('\n')}\n`;
    await writeFile(join(f.source, 'Acme.ts'), upstream);
    const review = await f.reviewOf();
    await expect(f.apply(review.operationId, { mergeMode: 'overwrite' })).rejects.toThrow(
      /Confirm forced overwrites/,
    );
    await expect(
      f.apply(review.operationId, { mergeMode: 'overwrite', confirmOverwrites: ['other.ts'] }),
    ).rejects.toThrow(/Confirm forced overwrites/);
    expect(await f.read('Acme.ts')).toBe(upstream);
    expect(await f.backups()).toEqual([]);
  });

  it('asks for no force on a clean push or a clean merge', async () => {
    const f = await fixture();
    await f.edit('Northwind.ts', editedLines(f.lines, 20, 'cloak edit'));
    const upstream = f.lines.map((line, index) => (index === 2 ? 'upstream of Acme' : line));
    await writeFile(join(f.source, 'Acme.ts'), `${upstream.join('\n')}\n`);
    expect((await f.apply((await f.reviewOf()).operationId)).state).toBe('completed');
  });

  it('cannot be applied through the generic operations route', async () => {
    const f = await fixture();
    await rm(join(f.workspace, 'gone.ts'));
    const review = await f.reviewOf();
    const base = f.base.slice(0, f.base.indexOf('/api/v2/'));
    const response = await fetch(`${base}/api/v2/operations/${review.operationId}/apply`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ deletions: true, force: true }),
    });
    expect(response.ok).toBe(false);
    expect(await f.read('gone.ts')).toBe('to be removed\n');
  });
});

describe('per-file push', () => {
  async function edited() {
    const f = await fixture();
    await f.edit('Northwind.ts', editedLines(f.lines, 1, 'edit one'));
    await f.edit('other.ts', 'class NorthwindOther { edit() {} }\n');
    await f.edit('NorthwindNew.ts', 'new Northwind file\n');
    await rm(join(f.workspace, 'gone.ts'));
    return f;
  }
  const paths = (review: PushReview) => review.files.map((file) => file.path).sort();
  const all = ['Northwind.ts', 'NorthwindNew.ts', 'gone.ts', 'other.ts'];

  it('writes only the selection and leaves the rest pending, intact and pushable', async () => {
    const f = await edited();
    const ledger = (await f.dashboard.sync.workspaceTarget(f.repoId, f.workspaceId)).snapshot.data
      .ledger;
    const cloak = {
      main: await readFile(join(f.workspace, 'Northwind.ts'), 'utf8'),
      added: await readFile(join(f.workspace, 'NorthwindNew.ts'), 'utf8'),
    };
    const sourceBefore = await f.read('Acme.ts');
    const review = await f.reviewOf();
    expect(paths(review)).toEqual(all);
    const done = await f.apply(review.operationId, { paths: ['other.ts'] });
    expect(done.state).toBe('completed');
    expect(done.result?.writes).toEqual(['other.ts']);
    expect(done.result?.deletes).toEqual([]);

    // Source: only the selected file changed.
    expect(await f.read('other.ts')).toContain('class AcmeOther { edit');
    expect(await f.read('Acme.ts')).toBe(sourceBefore);
    expect(await f.read('gone.ts')).toBe('to be removed\n');
    await expect(f.read('AcmeNew.ts')).rejects.toThrow();
    // Cloak: nothing was touched.
    expect(await readFile(join(f.workspace, 'Northwind.ts'), 'utf8')).toBe(cloak.main);
    expect(await readFile(join(f.workspace, 'NorthwindNew.ts'), 'utf8')).toBe(cloak.added);
    await expect(readFile(join(f.workspace, 'gone.ts'))).rejects.toThrow();
    // Ledger unchanged; the manifest moved on for the selected file only.
    const { snapshot } = await f.dashboard.sync.workspaceTarget(f.repoId, f.workspaceId);
    expect(snapshot.data.ledger).toEqual(ledger);
    expect(snapshot.plain.files['gone.ts']).toBeDefined();
    expect(snapshot.plain.files['NorthwindNew.ts']).toBeUndefined();

    // Repeat push sees everything else, and can finish the job.
    const again = await f.reviewOf();
    expect(paths(again)).toEqual(['Northwind.ts', 'NorthwindNew.ts', 'gone.ts']);
    const rest = await f.apply(again.operationId, { confirmDeletes: ['gone.ts'] });
    expect(rest.state).toBe('completed');
    expect(await f.read('Acme.ts')).toContain('edit one');
    expect(await f.read('AcmeNew.ts')).toBe('new Acme file\n');
    await expect(f.read('gone.ts')).rejects.toThrow();
    expect((await f.reviewOf()).files).toEqual([]);
  });

  it('keeps unselected edits out of the workspace checkpoint', async () => {
    const f = await edited();
    await f.apply((await f.reviewOf()).operationId, { paths: ['other.ts'] });
    expect(await f.git(f.workspace, 'show', '--name-only', '--format=', 'HEAD')).not.toContain(
      'Northwind.ts',
    );
    const status = await f.git(f.workspace, 'status', '--porcelain');
    expect(status).toContain('Northwind.ts');
    expect(status).toContain('NorthwindNew.ts');
    expect(status).not.toContain('other.ts');
  });

  it('survives a re-pull with unselected edits intact', async () => {
    const f = await edited();
    const main = await readFile(join(f.workspace, 'Northwind.ts'), 'utf8');
    const done = await f.apply((await f.reviewOf()).operationId, {
      paths: ['other.ts'],
      repull: true,
      mode: 'stage',
    });
    expect(done.state).toBe('completed');
    expect(done.result?.warnings.join()).not.toContain('re-pull failed');
    expect(await readFile(join(f.workspace, 'Northwind.ts'), 'utf8')).toBe(main);
    expect(paths(await f.reviewOf())).toEqual(['Northwind.ts', 'NorthwindNew.ts', 'gone.ts']);
    expect(await f.git(f.source, 'diff', '--cached', '--name-only')).toBe('other.ts');
  });

  it('commits only the selection', async () => {
    const f = await edited();
    await f.apply((await f.reviewOf()).operationId, {
      paths: ['other.ts'],
      mode: 'commit',
      commitMessage: 'Only other',
    });
    expect(await f.git(f.source, 'show', '--name-only', '--format=', 'HEAD')).toBe('other.ts');
  });

  it('asks to confirm only the deletions and overwrites it selected', async () => {
    const f = await edited();
    const upstream = `${f.lines.map((line, index) => (index === 1 ? 'upstream' : line)).join('\n')}\n`;
    await writeFile(join(f.source, 'Acme.ts'), upstream);
    const review = await f.reviewOf();
    expect(review.files.find((file) => file.path === 'Northwind.ts')?.flags).toContain('conflict');
    // The overlap and the deletion are outside this selection, so neither blocks nor needs a yes.
    const done = await f.apply(review.operationId, { paths: ['other.ts'] });
    expect(done.state).toBe('completed');
    expect(await f.read('Acme.ts')).toBe(upstream);
    expect(await f.read('gone.ts')).toBe('to be removed\n');

    const next = await f.reviewOf();
    await expect(f.apply(next.operationId, { paths: ['Northwind.ts'] })).rejects.toThrow(/overlap/);
    await expect(f.apply(next.operationId, { paths: ['gone.ts'] })).rejects.toThrow(/Confirm/);
    expect(
      (
        await f.apply(next.operationId, {
          paths: ['gone.ts'],
          confirmDeletes: ['gone.ts'],
        })
      ).result?.deletes,
    ).toEqual(['gone.ts']);
  });

  it('backs up and undoes only the selection', async () => {
    const f = await edited();
    const before = await f.read('other.ts');
    await f.apply((await f.reviewOf()).operationId, { paths: ['other.ts'] });
    const [backup] = await f.backups();
    expect(backup?.files).toBe(1);
    expect(await (await f.post(`/backups/${backup?.id}/undo`)).json()).toEqual({ restored: 1 });
    expect(await f.read('other.ts')).toBe(before);
    expect(paths(await f.reviewOf())).toEqual(all);
  });

  it('refuses paths the review did not list, and stays open', async () => {
    const f = await edited();
    const review = await f.reviewOf();
    await expect(f.apply(review.operationId, { paths: ['keys.ts'] })).rejects.toThrow(
      /not in this review/,
    );
    await expect(f.apply(review.operationId, { paths: ['../escape'] })).rejects.toThrow(
      /not in this review/,
    );
    await expect(f.apply(review.operationId, { paths: [] })).rejects.toThrow(/Invalid request/);
    expect((await f.apply(review.operationId, { paths: ['other.ts'] })).state).toBe('completed');
  });

  it('refuses when an unselected file changed after the review', async () => {
    const f = await edited();
    const review = await f.reviewOf();
    await f.edit('Northwind.ts', 'changed after review of Northwind\n');
    const done = await f.apply(review.operationId, { paths: ['other.ts'] });
    expect(done.state).toBe('failed');
    expect(done.code).toBe('stale');
    expect(await f.read('other.ts')).toBe('class AcmeOther {}\n');
  });

  it('applies a selection to a new worktree, leaving the rest pending', async () => {
    const f = await edited();
    const review = await f.reviewOf({ kind: 'new-worktree', branch: 'part' });
    const done = await f.apply(review.operationId, { paths: ['other.ts'] });
    expect(done.state).toBe('completed');
    const tree = done.result?.warnings.join() ?? '';
    const worktree = /New worktree: (.*?) \(/.exec(tree)?.[1] ?? '';
    expect(await f.read('other.ts', worktree)).toContain('edit()');
    expect(await f.read('Acme.ts', worktree)).not.toContain('edit one');
    expect(paths(await f.reviewOf())).toEqual(['Northwind.ts', 'NorthwindNew.ts', 'gone.ts']);
  });
});
