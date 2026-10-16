import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { hashJson } from '../core/hash.js';
import { validateSnapshot } from '../core/manifest.js';
import type { Snapshot } from '../core/manifest.js';
import type { PullPlan, RepoState } from '../core/pull.js';
import { parseDocument } from '../core/schemas.js';
import type { Document } from '../core/schemas.js';
import { writeAtomic } from './atomic.js';
import { getOrCreateKey, loadKey, open, seal } from './crypto.js';
import { checkDestinationPath, exists } from './files.js';
import type { createStore } from './store.js';

export function createSyncStore(store: ReturnType<typeof createStore>) {
  async function readConfig(): Promise<Document<'config'>> {
    return (await exists(join(store.root, 'config.json')))
      ? store.readPlain('config.json', 'config')
      : { kind: 'config', schemaVersion: 1 };
  }
  async function readRepo(repoId: string): Promise<Document<'repo'> | undefined> {
    const path = `repos/${repoId}/repo.json`;
    return (await exists(join(store.root, path))) ? store.readSealed(path, 'repo') : undefined;
  }
  async function readSnapshot(
    root: string,
  ): Promise<(Snapshot & { bytes: Uint8Array }) | undefined> {
    const path = join(root, '.repo-cloak', 'manifest.json');
    if (!(await exists(path))) return undefined;
    await checkDestinationPath(root, '.repo-cloak/manifest.json');
    const bytes = await readFile(path);
    const manifest = parseDocument('manifest', JSON.parse(bytes.toString('utf8')), path);
    const { sealed, ...plain } = manifest;
    return {
      ...validateSnapshot({
        plain,
        data: open(sealed, await loadKey(join(store.root, 'key')), plain) as Snapshot['data'],
      }),
      bytes,
    };
  }
  return {
    readConfig,
    readRepo,
    readSnapshot,
    async registerRepo(repo: RepoState): Promise<void> {
      const directory = join(store.root, 'repos', repo.repoId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await lock(directory, {
        retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
      });
      try {
        if (await readRepo(repo.repoId)) return;
        await store.writeSealed(`repos/${repo.repoId}/repo.json`, repo.repoId, 'repo', {
          kind: 'repo',
          schemaVersion: 1,
          repoId: repo.repoId,
          path: repo.path,
          commonDir: repo.commonDir,
          workspaces: {},
        });
      } finally {
        await release();
      }
    },
    async findWorkspace(cwd: string): Promise<string | undefined> {
      for (let root = cwd; ; root = dirname(root)) {
        if (await exists(join(root, '.repo-cloak', 'manifest.json'))) return root;
        if (dirname(root) === root) return undefined;
      }
    },
    async saveConfig(config: Document<'config'>) {
      await store.writePlain('config.json', 'config', config);
    },
    async sealManifest(plan: PullPlan): Promise<Uint8Array> {
      const key = await getOrCreateKey(join(store.root, 'key'));
      const manifest = { ...plan.plain, sealed: seal(plan.data, key, plan.plain) };
      parseDocument('manifest', manifest);
      return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    },
    async record(
      repo: RepoState,
      workspace: string,
      plan: PullPlan,
      manifest: Uint8Array,
      usedAt = plan.plain.pulls.at(-1)?.at,
    ): Promise<void> {
      const directory = join(store.root, 'repos', repo.repoId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await lock(directory, {
        retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
      });
      try {
        const record = await readRepo(repo.repoId);
        const previous = record?.workspaces[plan.plain.workspaceId];
        await store.writeSealed(`repos/${repo.repoId}/repo.json`, repo.repoId, 'repo', {
          ...record,
          $schema: 'https://unpkg.com/repo-cloak-cli@2/schemas/repo.schema.json',
          kind: 'repo',
          schemaVersion: 1,
          repoId: repo.repoId,
          path: repo.path,
          commonDir: repo.commonDir,
          workspaces: {
            ...record?.workspaces,
            [plan.plain.workspaceId]: {
              ...previous,
              path: workspace,
              createdAt: previous?.createdAt ?? plan.plain.pulls.at(-1)?.at,
              lastUsedAt: usedAt,
              useCount: (previous?.useCount ?? 0) + 1,
              lastProfiles: plan.data.profiles.map((profile) => profile.name),
              origin: plan.data.origin,
              target: { worktree: repo.path, branch: plan.data.target.branch, commit: repo.commit },
            },
          },
          extensions: record?.extensions ?? {},
        });
        const id = hashJson(plan.plain.workspaceId).slice(7);
        await writeAtomic(join(directory, 'manifests', `${id}.json`), manifest);
      } finally {
        await release();
      }
    },
    newId: randomUUID,
  };
}
