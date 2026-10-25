import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  chmod,
  realpath,
  symlink,
} from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { lock } from 'proper-lockfile';
import { z } from 'zod';
import { createStore } from './store.js';
import { createSyncStore } from './sync-store.js';
import { createAgentStore } from './agent-store.js';
import { createAgentClientConfig } from './agent-client-config.js';
import { writeAtomic, errorCode } from './atomic.js';
import { canonicalPath, isWithin } from './locations.js';
import { checkDestinationPath, exists } from './files.js';
import { findRepo } from './git.js';
import { hashBytes, hashJson } from '../core/hash.js';
import { groupGuidance } from '../core/group-guidance.js';
import { agentSkill, instructionFiles, addAgentGuidance } from '../core/agent-guidance.js';
import type { GroupMember, RepositoryGroup } from '../core/groups.js';
import type { Snapshot } from '../core/manifest.js';

export type GroupCopyTarget = GroupMember & { path: string; snapshot: Snapshot };
const helperNames = [
  'AGENTS.md',
  'CLAUDE.md',
  '.codex/config.toml',
  '.mcp.json',
  '.gitignore',
] as const;
const folderMetadata = z.object({
  protocol: z.literal(1),
  groupId: z.uuid(),
  hashes: z.record(z.enum(helperNames), z.string()),
});

export function createGroupFolder(store = createStore()) {
  const records = createSyncStore(store);
  const agents = createAgentStore(store);
  const clients = createAgentClientConfig();

  async function installGuidance(path: string, snapshot: Snapshot) {
    const generated = new Set(snapshot.data.guidance?.generated ?? []);
    for (const name of instructionFiles) {
      const file = join(path, name);
      if (!(await exists(file))) {
        if (snapshot.plain.files[name]) continue; // Preserve an intentional tracked deletion.
        generated.add(name);
        await writeAtomic(file, addAgentGuidance(''));
      } else if (!snapshot.data.guidance) {
        const before = await readFile(file);
        const after = Buffer.from(addAgentGuidance(before.toString('utf8')));
        await writeAtomic(file, after);
        const baseline = snapshot.plain.files[name];
        if (baseline && baseline.hash === hashBytes(before))
          snapshot.plain.files[name] = {
            ...baseline,
            hash: hashBytes(after),
            size: after.byteLength,
          };
      }
    }
    snapshot.data.guidance = { generated: [...generated] };
  }

  async function copyTree(root: string, source: string, destination: string, copyRoot: string) {
    const name = relative(root, source).split('\\').join('/');
    if (name === '.codex' || name === '.mcp.json' || name === '.repo-cloak/agent') return;
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(source);
      if (!isWithin(root, resolved))
        throw new Error('Cannot copy symbolic links outside the cloak workspace');
      const target = join(copyRoot, relative(root, resolved));
      const directory = (await lstat(resolved)).isDirectory();
      await symlink(
        process.platform === 'win32' ? target : relative(dirname(destination), target),
        destination,
        process.platform === 'win32' ? (directory ? 'junction' : 'file') : undefined,
      );
      return;
    }
    if ((await canonicalPath(source)) !== source)
      throw new Error('Workspace path changed during copying');
    if (info.isDirectory()) {
      if (source !== root) await mkdir(destination, { mode: 0o700 });
      for (const entry of await readdir(source))
        await copyTree(root, join(source, entry), join(destination, entry), copyRoot);
    } else {
      if (!info.isFile()) throw new Error('Cannot copy special workspace files');
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      const after = await lstat(source);
      if (
        after.isSymbolicLink() ||
        info.size !== after.size ||
        info.mtimeMs !== after.mtimeMs ||
        info.ino !== after.ino ||
        (await canonicalPath(source)) !== source
      )
        throw new Error('Workspace files changed during copying; try again');
      if (process.platform !== 'win32') await chmod(destination, info.mode & 0o777);
    }
  }

  async function forget(repoId: string, workspaceId: string) {
    const directory = join(store.root, 'repos', repoId);
    const release = await lock(directory, { retries: 0 });
    try {
      const repo = await records.readRepo(repoId);
      if (repo) {
        const workspaces = Object.fromEntries(
          Object.entries(repo.workspaces).filter(([id]) => id !== workspaceId),
        );
        await store.writeSealed(`repos/${repoId}/repo.json`, repoId, 'repo', {
          ...repo,
          workspaces,
        });
      }
      for (const file of [
        `agents/${workspaceId}.json`,
        `repos/${repoId}/manifests/${hashJson(workspaceId).slice(7)}.json`,
      ])
        await store.remove(file).catch((error) => {
          if (errorCode(error) !== 'ENOENT') throw error;
        });
    } finally {
      await release();
    }
  }

  async function validateParent(root: string) {
    root = await canonicalPath(root);
    let ancestor = root;
    while (!(await exists(ancestor))) ancestor = dirname(ancestor);
    if (
      (await findRepo(ancestor)) ||
      (await records.findWorkspace(ancestor)) ||
      isWithin(store.root, root)
    )
      throw new Error(
        'Group folders must be outside repositories, workspaces and the private store',
      );
    for (let path = root; ; path = dirname(path)) {
      if (await exists(join(path, '.repo-cloak/group.json')))
        throw new Error('Choose a location outside other group folders');
      if (dirname(path) === path) break;
    }
    return root;
  }

  return {
    async save<T>(
      group: RepositoryGroup,
      targets: GroupCopyTarget[],
      folderRoot: string | undefined,
      persist: (value: RepositoryGroup) => Promise<T>,
    ): Promise<T> {
      const configured = (await records.readConfig()).workspacesRoot;
      let fallback = dirname(targets[0]?.path ?? store.root);
      while (await exists(join(fallback, '.repo-cloak/group.json'))) fallback = dirname(fallback);
      const parent = await validateParent(
        group.folder ? dirname(group.folder) : folderRoot || configured || fallback,
      );
      const folder = group.folder ?? join(parent, `group-${group.id.slice(0, 8)}`);
      if (isWithin(store.root, folder) || isWithin(folder, store.root))
        throw new Error('Group folders must be outside the private store');
      if ((await canonicalPath(folder)) !== folder) throw new Error('Group folder path changed');
      const createdRoot = !group.folder;
      const created: { repoId: string; workspaceId: string; path: string }[] = [];
      const backups = new Map<string, Buffer | undefined>();
      const releases: (() => Promise<void>)[] = [];
      let rootRelease: (() => Promise<void>) | undefined;
      let succeeded = false;
      let started = false;
      let preserveRoot = false;
      try {
        if (createdRoot) {
          await mkdir(parent, { recursive: true, mode: 0o700 });
          await mkdir(folder, { mode: 0o700 }); // Exclusive: never adopt an existing directory.
          started = true;
        } else {
          if (!(await lstat(folder)).isDirectory())
            throw new Error('Group folder is missing or unsafe');
          await checkDestinationPath(folder, '.repo-cloak/group.json');
          const metadata = folderMetadata.parse(
            JSON.parse(await readFile(join(folder, '.repo-cloak/group.json'), 'utf8')),
          );
          if (metadata.groupId !== group.id)
            throw new Error('Group folder belongs to another group');
          for (const [file, expected] of Object.entries(metadata.hashes)) {
            await checkDestinationPath(folder, file);
            const bytes = await readFile(join(folder, file));
            if (hashBytes(bytes) !== expected)
              throw new Error(
                'Generated group helper files changed; restore them before editing the group',
              );
            backups.set(file, bytes);
          }
          backups.set(
            '.repo-cloak/group.json',
            await readFile(join(folder, '.repo-cloak/group.json')),
          );
        }
        rootRelease = await lock(folder, { retries: 0 });
        const seen = new Set<string>();
        for (const target of [...targets].sort((a, b) => a.path.localeCompare(b.path))) {
          if (seen.has(target.path)) continue;
          seen.add(target.path);
          releases.push(await lock(target.path, { retries: 0 }));
        }
        const members: GroupMember[] = [];
        const connections = [];
        const usedNames = new Set(
          [...(await readdir(folder)), ...helperNames, '.codex', '.repo-cloak'].map((name) =>
            name.toLowerCase(),
          ),
        );
        for (const target of targets) {
          let path = target.path;
          let workspaceId = target.workspaceId;
          if (dirname(path) !== folder) {
            if (isWithin(path, folder) || isWithin(folder, path))
              throw new Error('Group and workspace folders must not overlap');
            const current = await records.readSnapshot(path);
            if (
              !current ||
              current.plain.workspaceId !== target.workspaceId ||
              current.plain.source.repoId !== target.repoId ||
              hashJson(current.plain) !== hashJson(target.snapshot.plain) ||
              hashJson(current.data) !== hashJson(target.snapshot.data)
            )
              throw new Error('Workspace manifest changed; refresh before grouping');
            const git = await findRepo(path);
            if (git && (git.topLevel !== path || !isWithin(path, git.commonDir)))
              throw new Error('Only standalone cloak repositories can be copied');
            if (
              git &&
              (!(await lstat(join(path, '.git'))).isDirectory() ||
                (await exists(join(path, '.git/objects/info/alternates'))))
            )
              throw new Error(
                'Git metadata must be self-contained before copying a cloak repository',
              );
            workspaceId = randomUUID();
            const name =
              basename(path)
                .replace(/[^A-Za-z0-9._-]/g, '-')
                .slice(0, 100) || 'workspace';
            path = join(folder, name);
            if (usedNames.has(name.toLowerCase()))
              path = join(folder, `${name}-${workspaceId.slice(0, 8)}`);
            await mkdir(path, { mode: 0o700 });
            usedNames.add(basename(path).toLowerCase());
            created.push({ repoId: target.repoId, workspaceId, path });
            await copyTree(target.path, target.path, path, path);
            const snapshot = structuredClone(current);
            snapshot.plain.workspaceId = workspaceId;
            snapshot.plain.extensions = { ...snapshot.plain.extensions, groupId: group.id };
            await installGuidance(path, snapshot);
            const manifest = await records.sealManifest(snapshot);
            await writeAtomic(join(path, '.repo-cloak/manifest.json'), manifest);
            await agents.ensure({
              repoId: target.repoId,
              workspaceId,
              path,
              worktree: snapshot.data.source.path,
            });
            await writeAtomic(join(path, '.repo-cloak/agent/SKILL.md'), agentSkill);
            await writeAtomic(join(path, '.repo-cloak/agent/.gitignore'), '*\n');
            await records.recordCopy(target.repoId, target.workspaceId, path, snapshot, manifest);
          }
          members.push({ repoId: target.repoId, workspaceId, worktree: target.worktree });
          connections.push({ directory: basename(path), ...clients.info(workspaceId, path) });
        }
        const guidance = groupGuidance(
          connections.map((item) => ({ directory: item.directory, server: item.name })),
        );
        const files: Record<string, string> = {
          'AGENTS.md': guidance,
          'CLAUDE.md': guidance,
          '.codex/config.toml': connections.map((item) => item.codex).join('\n'),
          '.mcp.json':
            JSON.stringify(
              {
                mcpServers: Object.assign(
                  {},
                  ...connections.map((item) => JSON.parse(item.claude).mcpServers as object),
                ),
              },
              null,
              2,
            ) + '\n',
          '.gitignore': '/.codex/\n/.mcp.json\n/.repo-cloak/\n',
        };
        for (const [file, contents] of Object.entries(files)) {
          await checkDestinationPath(folder, file);
          if (!backups.has(file)) backups.set(file, undefined);
          await writeAtomic(join(folder, file), contents);
        }
        await checkDestinationPath(folder, '.repo-cloak/group.json');
        await writeAtomic(
          join(folder, '.repo-cloak/group.json'),
          JSON.stringify(
            {
              protocol: 1,
              groupId: group.id,
              members: connections.map((item) => ({
                directory: item.directory,
                server: item.name,
              })),
              hashes: Object.fromEntries(
                Object.entries(files).map(([file, contents]) => [
                  file,
                  hashBytes(Buffer.from(contents)),
                ]),
              ),
            },
            null,
            2,
          ) + '\n',
        );
        const result = await persist({ ...group, folder, members });
        succeeded = true;
        return result;
      } catch (error) {
        const failures: unknown[] = [];
        for (const item of [...created].reverse()) {
          try {
            await forget(item.repoId, item.workspaceId);
            await rm(item.path, { recursive: true, force: true });
          } catch (failure) {
            failures.push(failure);
          }
        }
        if (!createdRoot)
          for (const [file, bytes] of backups) {
            try {
              if (bytes) await writeAtomic(join(folder, file), bytes);
              else await rm(join(folder, file), { force: true });
            } catch (failure) {
              failures.push(failure);
            }
          }
        if (failures.length) {
          preserveRoot = true;
          throw new AggregateError(
            [error, ...failures],
            `Group copy cleanup failed; recovery folder: ${folder}`,
            { cause: error },
          );
        }
        throw error;
      } finally {
        for (const release of releases.reverse()) await release();
        await rootRelease?.();
        if (!succeeded && !preserveRoot && createdRoot && started)
          await rm(folder, { recursive: true, force: true });
      }
    },
  };
}
