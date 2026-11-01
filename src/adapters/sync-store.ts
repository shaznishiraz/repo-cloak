import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { lock } from 'proper-lockfile';
import { hashJson } from '../core/hash.js';
import { validateSnapshot } from '../core/manifest.js';
import type { Snapshot } from '../core/manifest.js';
import type { RepoState } from '../core/pull.js';
import { parseDocument } from '../core/schemas.js';
import type { Document } from '../core/schemas.js';
import { writeAtomic } from './atomic.js';
import { checkDestinationPath, exists } from './files.js';
import type { createStore } from './store.js';

export function createSyncStore(store: ReturnType<typeof createStore>) {
  async function readConfig(): Promise<Document<'config'>> {
    return (await exists(join(store.root, 'config.json')))
      ? store.readPlain('config.json', 'config')
      : { kind: 'config', schemaVersion: 1 };
  }
  /** The stored record, for read-modify-write. Policy exclusions never get persisted into it. */
  async function readRepoRecord(repoId: string): Promise<Document<'repo'> | undefined> {
    const path = `repos/${repoId}/repo.json`;
    return (await exists(join(store.root, path))) ? store.readSealed(path, 'repo') : undefined;
  }
  /** What every reader enforces: the repo's exclusions plus any locked by machine policy. */
  async function readRepo(repoId: string): Promise<Document<'repo'> | undefined> {
    const repo = await readRepoRecord(repoId);
    if (!repo) return undefined;
    const policy = await store.policy();
    const locked = policy.status === 'active' ? (policy.policy.lockedExclusions ?? []) : [];
    if (!locked.length) return repo;
    return { ...repo, exclude: [...new Set([...locked, ...(repo.exclude ?? [])])] };
  }
  /**
   * A policy that exists but cannot be trusted has unknown locked exclusions, so nothing may
   * leave the source until it is fixed. Restoring into the source stays available.
   */
  async function requireUsablePolicy() {
    const policy = await store.policy();
    if (policy.status === 'invalid')
      throw new Error(
        `Machine policy at ${policy.path} is invalid, so files cannot leave the source until it is fixed: ${policy.message}`,
      );
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
        data: (await store.opener())(sealed, plain) as Snapshot['data'],
      }),
      bytes,
    };
  }
  return {
    requireUsablePolicy,
    readConfig,
    readRepo,
    readRepoRecord,
    readSnapshot,
    /** Registered source repos whose folder still exists. */
    async listRepos(): Promise<{ repoId: string; path: string }[]> {
      const repos: { repoId: string; path: string }[] = [];
      for (const id of await store.listDirectories('repos')) {
        const repo = await readRepo(id);
        if (repo && !repo.hidden && (await exists(repo.path)))
          repos.push({ repoId: id, path: repo.path });
      }
      return repos;
    },
    async registerRepo(repo: RepoState): Promise<void> {
      const previous = await readRepo(repo.repoId);
      if (previous && !previous.hidden) return;
      const directory = join(store.root, 'repos', repo.repoId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await lock(directory, {
        retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
      });
      try {
        const current = await readRepoRecord(repo.repoId);
        if (current) {
          if (current.hidden)
            await store.writeSealed(`repos/${repo.repoId}/repo.json`, repo.repoId, 'repo', {
              ...current,
              hidden: false,
            });
          return;
        }
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
    async setRepoPinned(repoId: string, pinned: boolean): Promise<void> {
      const directory = join(store.root, 'repos', repoId);
      const release = await lock(directory, {
        retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
      });
      try {
        const record = await readRepoRecord(repoId);
        if (!record) throw new Error('Repository is not registered');
        await store.writeSealed(`repos/${repoId}/repo.json`, repoId, 'repo', { ...record, pinned });
      } finally {
        await release();
      }
    },
    async setRepoHidden(repoId: string, hidden: boolean): Promise<void> {
      const directory = join(store.root, 'repos', repoId);
      const release = await lock(directory, {
        retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
      });
      try {
        const record = await readRepoRecord(repoId);
        if (!record) throw new Error('Repository is not registered');
        await store.writeSealed(`repos/${repoId}/repo.json`, repoId, 'repo', { ...record, hidden });
      } finally {
        await release();
      }
    },
    async saveRepoExclusions(repoId: string, patterns: string[]): Promise<void> {
      const directory = join(store.root, 'repos', repoId);
      const release = await lock(directory, {
        retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
      });
      try {
        const record = await readRepoRecord(repoId);
        if (!record) throw new Error('Repository is not registered');
        await store.writeSealed(`repos/${repoId}/repo.json`, repoId, 'repo', {
          ...record,
          exclude: patterns,
        });
      } finally {
        await release();
      }
    },
    async saveRepoPostCheck(
      repoId: string,
      postCheck: { command: string; timeoutSeconds: number } | null,
    ): Promise<void> {
      const directory = join(store.root, 'repos', repoId);
      const release = await lock(directory, {
        retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
      });
      try {
        const record = await readRepoRecord(repoId);
        if (!record) throw new Error('Repository is not registered');
        const next: Document<'repo'> = { ...record };
        if (postCheck) next.postCheck = postCheck;
        else delete next.postCheck;
        await store.writeSealed(`repos/${repoId}/repo.json`, repoId, 'repo', next);
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
    async sealManifest<T extends Snapshot>(plan: T): Promise<Uint8Array> {
      const seal = await store.sealer();
      const manifest = { ...plan.plain, sealed: seal(plan.data, plan.plain) };
      parseDocument('manifest', manifest);
      return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    },
    async relocateWorkspace(
      repoId: string,
      workspaceId: string,
      expectedPath: string,
      workspace: Document<'repo'>['workspaces'][string],
    ) {
      const directory = join(store.root, 'repos', repoId);
      const release = await lock(directory, { retries: 0 });
      try {
        const repo = await readRepoRecord(repoId);
        if (!repo || repo.hidden || repo.workspaces[workspaceId]?.path !== expectedPath)
          throw new Error('Workspace registration changed while moving');
        await store.writeSealed(`repos/${repoId}/repo.json`, repoId, 'repo', {
          ...repo,
          workspaces: {
            ...repo.workspaces,
            [workspaceId]: workspace,
          },
        });
      } finally {
        await release();
      }
    },
    async record(
      repo: RepoState,
      workspace: string,
      plan: Snapshot,
      manifest: Uint8Array,
      usedAt = plan.plain.pulls.at(-1)?.at,
    ): Promise<void> {
      const directory = join(store.root, 'repos', repo.repoId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const release = await lock(directory, {
        retries: { retries: 8, minTimeout: 25, maxTimeout: 100 },
      });
      try {
        const record = await readRepoRecord(repo.repoId);
        const previous = record?.workspaces[plan.plain.workspaceId];
        await store.writeSealed(`repos/${repo.repoId}/repo.json`, repo.repoId, 'repo', {
          ...record,
          $schema: 'https://unpkg.com/repo-cloak-cli@2/schemas/repo.schema.json',
          kind: 'repo',
          schemaVersion: 1,
          repoId: repo.repoId,
          // A push or pull can target any worktree; the repo stays where it was registered
          // unless that folder is gone, or removing a worktree would orphan the repo.
          path: record?.path && (await exists(record.path)) ? record.path : repo.path,
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
              ...(typeof plan.plain.extensions?.groupId === 'string'
                ? { groupId: plan.plain.extensions?.groupId }
                : {}),
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
