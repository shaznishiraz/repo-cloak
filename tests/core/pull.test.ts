import { describe, expect, it } from 'vitest';
import { planPull } from '../../src/core/pull.js';
import type { PullInput, SourceFile } from '../../src/core/pull.js';
import { validateProfile } from '../../src/core/rules.js';
import { hashBytes } from '../../src/core/hash.js';

function textFile(path: string, text: string): SourceFile {
  return { path, bytes: Buffer.from(text), text, binary: false, executable: false };
}
function input(): PullInput {
  return {
    repo: {
      repoId: 'a'.repeat(16),
      path: '/source/acme',
      branch: 'feature/acme',
      commit: 'b'.repeat(40),
    },
    workspaceId: 'ws_test',
    pullId: 'p_test',
    at: '2026-10-16T10:00:00Z',
    version: '2.0.0',
    profiles: [
      {
        id: 'pf_test',
        scope: { kind: 'global' },
        profile: validateProfile({
          kind: 'profile',
          schemaVersion: 1,
          name: 'acme',
          rules: [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Northwind' }],
        }),
      },
    ],
    files: [textFile('src/Acme.ts', 'export class Acme {}\r\n')],
    workspace: {},
    selection: { files: 1, commits: 0, working: false, extra: 0 },
  };
}
describe('extraction plan', () => {
  it('keeps source names, paths and profile names out of the public manifest', () => {
    const result = planPull(input());
    expect(result.writes[0]?.path).toBe('src/Northwind.ts');
    expect(Buffer.from(result.writes[0]?.bytes ?? []).toString()).toBe(
      'export class Northwind {}\r\n',
    );
    expect(JSON.stringify(result.plain)).not.toMatch(/acme|\/source|feature\//i);
    expect(result.data.files['src/Northwind.ts']?.path).toBe('src/Acme.ts');
    expect(result.data.profiles[0]?.name).toBe('acme');
    expect(result.plain.files['src/Northwind.ts']?.hash).toBe(
      hashBytes(result.writes[0]?.bytes ?? new Uint8Array()),
    );
  });
  it('copies binary bytes unchanged and warns about them', () => {
    const request = input();
    const bytes = Uint8Array.from([0, 255, 65, 99, 109, 101]);
    request.files = [{ path: 'Acme.bin', bytes, binary: true, executable: false }];
    const result = planPull(request);
    expect(result.writes[0]?.bytes).toEqual(bytes);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('binary')]));
  });
  it('preserves workspace edits when the source is unchanged', () => {
    const request = input();
    const first = planPull(request);
    request.previous = { plain: first.plain, data: first.data };
    request.workspace = { 'src/Northwind.ts': Buffer.from('class Northwind { edited = true }') };
    const result = planPull(request);
    expect(result.writes).toEqual([]);
    expect(result.plain.files['src/Northwind.ts']?.hash).toBe(
      first.plain.files['src/Northwind.ts']?.hash,
    );
  });
  it('updates an unchanged workspace after a source edit', () => {
    const request = input();
    const first = planPull(request);
    request.previous = { plain: first.plain, data: first.data };
    request.workspace = Object.fromEntries(first.writes.map((file) => [file.path, file.bytes]));
    request.files = [textFile('src/Acme.ts', 'class Acme { source = true }')];
    expect(Buffer.from(planPull(request).writes[0]?.bytes ?? []).toString()).toBe(
      'class Northwind { source = true }',
    );
  });
  it('writes nothing when source and workspace both changed', () => {
    const request = input();
    const first = planPull(request);
    request.previous = { plain: first.plain, data: first.data };
    request.workspace = { 'src/Northwind.ts': Buffer.from('workspace edit') };
    request.files = [textFile('src/Acme.ts', 'source edit')];
    expect(() => planPull(request)).toThrow(/src\/Northwind.ts.*both/i);
  });
  it('handles source deletion without discarding edited workspace files', () => {
    const request = input();
    const first = planPull(request);
    request.previous = { plain: first.plain, data: first.data };
    request.workspace = Object.fromEntries(first.writes.map((file) => [file.path, file.bytes]));
    request.files = [{ path: 'src/Acme.ts', binary: false, executable: false }];
    expect(planPull(request).deletes).toEqual(['src/Northwind.ts']);
    request.workspace = { 'src/Northwind.ts': Buffer.from('workspace edit') };
    expect(() => planPull(request)).toThrow(/both/i);
  });
  it('refuses to overwrite an untracked destination file', () => {
    const request = input();
    request.workspace = { 'src/Northwind.ts': Buffer.from('mine') };
    expect(() => planPull(request)).toThrow(/untracked|overwrite/i);
  });
  it('requires a clean workspace when profiles change', () => {
    const request = input();
    const first = planPull(request);
    request.previous = { plain: first.plain, data: first.data };
    request.workspace = { 'src/Northwind.ts': Buffer.from('workspace edit') };
    const saved = request.profiles[0];
    if (saved)
      saved.profile.rules = [{ id: 'company', type: 'literal', match: 'Acme', replace: 'Contoso' }];
    expect(() => planPull(request)).toThrow(/profile.*edited|edited.*profile/i);
  });
});
