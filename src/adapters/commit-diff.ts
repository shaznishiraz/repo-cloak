import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Ledger } from '../core/ledger.js';
import { checkPathCollisions, validateRelativePath } from '../core/paths.js';
import { createReplacer } from '../core/replacer.js';
import type { SourceFile } from '../core/pull.js';
import type { Rule } from '../core/rules.js';

const exec = promisify(execFile);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const diffLimit = 1024 * 1024;

export async function createCommitDiff(input: {
  root: string;
  before: SourceFile[];
  after: SourceFile[];
  paths: string[];
  rules: Rule[];
  ledger: Ledger;
}) {
  const before = new Map(input.before.map((file) => [file.path, file]));
  const after = new Map(input.after.map((file) => [file.path, file]));
  const replacer = createReplacer(input.rules);
  let ledger = structuredClone(input.ledger);
  const paths = [...new Set(input.paths.map(validateRelativePath))].sort();
  const changes = paths.map((path) => {
    const result = replacer.anonymize(path, { file: path, scope: 'paths' }, ledger);
    ledger = result.ledger;
    return { original: path, anonymized: result.text };
  });
  checkPathCollisions(changes, false);
  const directory = await mkdtemp(join(tmpdir(), 'repo-cloak-export-'));
  const output: {
    path: string;
    patch: string;
    added: number | null;
    removed: number | null;
    binary: boolean;
  }[] = [];
  let size = 0;
  let skipped = 0;
  try {
    for (const change of changes) {
      const oldFile = before.get(change.original);
      const newFile = after.get(change.original);
      const oldBytes = oldFile?.bytes ?? Buffer.alloc(0);
      const newBytes = newFile?.bytes ?? Buffer.alloc(0);
      if ((oldFile && oldFile.binary) || (newFile && newFile.binary)) {
        output.push({
          path: change.anonymized,
          patch: `diff --git a/${change.anonymized} b/${change.anonymized}\nBinary file omitted: ${change.anonymized}`,
          added: null,
          removed: null,
          binary: true,
        });
        skipped++;
        continue;
      }
      let oldText: string;
      let newText: string;
      try {
        oldText = oldBytes.length ? decoder.decode(oldBytes) : '';
        newText = newBytes.length ? decoder.decode(newBytes) : '';
      } catch {
        output.push({
          path: change.anonymized,
          patch: `diff --git a/${change.anonymized} b/${change.anonymized}\nBinary file omitted: ${change.anonymized}`,
          added: null,
          removed: null,
          binary: true,
        });
        skipped++;
        continue;
      }
      // Full source blobs can be large while their anonymized patch is tiny.
      // Apply the export budget to the generated patch below, not the inputs.
      const oldResult = replacer.anonymize(
        oldText,
        { file: change.original, scope: 'content' },
        ledger,
      );
      ledger = oldResult.ledger;
      const newResult = replacer.anonymize(
        newText,
        { file: change.original, scope: 'content' },
        ledger,
      );
      ledger = newResult.ledger;
      const oldPath = join(directory, `old-${output.length}`);
      const newPath = join(directory, `new-${output.length}`);
      await Promise.all([
        writeFile(oldPath, oldResult.text, { mode: 0o600 }),
        writeFile(newPath, newResult.text, { mode: 0o600 }),
      ]);
      let patch = '';
      try {
        patch = (
          await exec(
            'git',
            [
              'diff',
              '--no-index',
              '--no-ext-diff',
              '--no-textconv',
              '--no-color',
              '--unified=3',
              '--',
              oldPath,
              newPath,
            ],
            { cwd: input.root, encoding: 'utf8', windowsHide: true, maxBuffer: diffLimit * 4 },
          )
        ).stdout;
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 1)
          throw error;
        patch = String('stdout' in error ? error.stdout : '');
      }
      const lines = patch.split('\n');
      const header = lines.findIndex((line) => line.startsWith('@@'));
      if (header < 0) {
        const oldLabel = oldFile?.bytes !== undefined ? `a/${change.anonymized}` : '/dev/null';
        const newLabel = newFile?.bytes !== undefined ? `b/${change.anonymized}` : '/dev/null';
        output.push({
          path: change.anonymized,
          patch: [
            `diff --git a/${change.anonymized} b/${change.anonymized}`,
            `--- ${oldLabel}`,
            `+++ ${newLabel}`,
            'No text changes after anonymization.',
          ].join('\n'),
          added: 0,
          removed: 0,
          binary: false,
        });
        continue;
      }
      const oldLabel = oldFile?.bytes !== undefined ? `a/${change.anonymized}` : '/dev/null';
      const newLabel = newFile?.bytes !== undefined ? `b/${change.anonymized}` : '/dev/null';
      const body = lines.slice(header);
      const filePatch = [
        `diff --git a/${change.anonymized} b/${change.anonymized}`,
        `--- ${oldLabel}`,
        `+++ ${newLabel}`,
        ...body,
      ].join('\n');
      size += Buffer.byteLength(filePatch);
      if (size > diffLimit) throw new Error('This commit exceeds the 1 MiB anonymized diff limit');
      const changedLines = body.filter(
        (line) =>
          (line.startsWith('+') && !line.startsWith('+++ ')) ||
          (line.startsWith('-') && !line.startsWith('--- ')),
      );
      output.push({
        path: change.anonymized,
        patch: filePatch,
        added: changedLines.filter((line) => line.startsWith('+')).length,
        removed: changedLines.filter((line) => line.startsWith('-')).length,
        binary: false,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const patch = output.map((file) => file.patch).join('\n');
  if (Buffer.byteLength(patch) > diffLimit)
    throw new Error('This commit exceeds the 1 MiB anonymized diff limit');
  return {
    patch,
    files: output,
    skipped,
  };
}
