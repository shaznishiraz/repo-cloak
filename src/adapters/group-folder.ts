import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  chmod,
  realpath,
  symlink,
  readlink,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
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
import { prepareWorkspaceCheckpoint } from './workspace-git.js';
import { hashBytes, hashJson } from '../core/hash.js';
import { groupGuidance } from '../core/group-guidance.js';
import { agentSkill, instructionFiles, addAgentGuidance } from '../core/agent-guidance.js';
import type { GroupMember, RepositoryGroup } from '../core/groups.js';
import type { Snapshot } from '../core/manifest.js';
import type { Document } from '../core/schemas.js';
import { createGroupStore } from './groups.js';

export type GroupMoveTarget = GroupMember & { path: string; snapshot: Snapshot };
type Link = { path: string; before: string; target: string; directory: boolean };
type Backup = { bytes: Buffer; mode: number } | undefined;
type Move = {
  target: GroupMoveTarget;
  path: string;
  previous: Document<'repo'>['workspaces'][string];
  backups: Map<string, Backup>;
  links: Link[];
  hadAgent: boolean;
  hadGit: boolean;
  moved: boolean;
  registered: boolean;
};
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

export function createGroupFolder(
  store = createStore(),
  moveDirectory: (from: string, to: string) => Promise<void> = rename,
) {
  const records = createSyncStore(store);
  const agents = createAgentStore(store);
  const clients = createAgentClientConfig();
  const groups = createGroupStore(store);

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

  async function inspectTree(root: string, source = root, links: Link[] = []): Promise<Link[]> {
    const name = relative(root, source).split('\\').join('/');
    const info = await lstat(source);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(source);
      if (!isWithin(root, resolved))
        throw new Error('Cannot move symbolic links outside the cloak workspace');
      const before = await readlink(source);
      if (isAbsolute(before))
        links.push({
          path: name,
          before,
          target: relative(root, resolved),
          directory: (await lstat(resolved)).isDirectory(),
        });
      return links;
    }
    if ((await canonicalPath(source)) !== source)
      throw new Error('Workspace path changed while preparing the move');
    if (info.isDirectory()) {
      for (const entry of await readdir(source))
        await inspectTree(root, join(source, entry), links);
    } else if (!info.isFile()) throw new Error('Cannot move special workspace files');
    return links;
  }

  async function restore(path: string, backup: Backup) {
    if (backup) {
      await writeAtomic(path, backup.bytes);
      if (process.platform !== 'win32') await chmod(path, backup.mode);
    } else await rm(path, { force: true });
  }

  async function rewriteLink(root: string, link: Link, restoring = false) {
    const path = join(root, link.path);
    const target = join(root, link.target);
    await unlink(path).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
    await symlink(
      restoring
        ? link.before
        : process.platform === 'win32'
          ? target
          : relative(dirname(path), target),
      path,
      process.platform === 'win32' ? (link.directory ? 'junction' : 'file') : undefined,
    );
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
      targets: GroupMoveTarget[],
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
      const moves: Move[] = [];
      const privateBackups = new Map<string, Backup>();
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
          const workspaceId = target.workspaceId;
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
            if (git && (git.topLevel !== path || git.commonDir !== join(path, '.git')))
              throw new Error('Only standalone cloak repositories can be moved');
            if (
              git &&
              (!(await lstat(join(path, '.git'))).isDirectory() ||
                (await exists(join(path, '.git/objects/info/alternates'))))
            )
              throw new Error(
                'Git metadata must be self-contained before moving a cloak repository',
              );
            if (
              (await exists(join(path, '.git/worktrees'))) &&
              (await readdir(join(path, '.git/worktrees'))).length
            )
              throw new Error('Remove linked Git worktrees before moving this cloak workspace');
            const parentMetadata = join(dirname(path), '.repo-cloak/group.json');
            if (await exists(parentMetadata)) {
              const owner = JSON.parse(await readFile(parentMetadata, 'utf8')) as {
                groupId: string;
              };
              if (owner.groupId !== group.id && (await groups.read(owner.groupId)))
                throw new Error('This workspace already lives in another group folder');
            }
            const previous = (await records.readRepo(target.repoId))?.workspaces[workspaceId];
            if (!previous || previous.path !== target.path)
              throw new Error('Workspace registration changed while preparing the move');
            const links = await inspectTree(path);
            const name =
              basename(path)
                .replace(/[^A-Za-z0-9._-]/g, '-')
                .slice(0, 100) || 'workspace';
            path = join(folder, name);
            for (let suffix = 0; usedNames.has(basename(path).toLowerCase()); suffix++)
              path = join(
                folder,
                `${name}-${workspaceId.slice(0, 8)}${suffix ? `-${suffix}` : ''}`,
              );
            await mkdir(path, { mode: 0o700 });
            usedNames.add(basename(path).toLowerCase());
            const item: Move = {
              target,
              path,
              previous,
              links,
              backups: new Map(),
              hadAgent: !!(await agents.read(workspaceId)),
              hadGit: !!git,
              moved: false,
              registered: false,
            };
            moves.push(item);
            try {
              // POSIX rename replaces only our exclusively created empty reservation.
              if (process.platform === 'win32') await rmdir(path);
              await moveDirectory(target.path, path);
              item.moved = true;
            } catch (error) {
              if (errorCode(error) === 'EXDEV')
                throw new Error(
                  'Choose a group folder on the same filesystem as the cloak workspaces.',
                  { cause: error },
                );
              throw error;
            }
            releases.push(await lock(path, { retries: 0 }));
            if (git) {
              const movedGit = await findRepo(path);
              if (
                !movedGit ||
                movedGit.topLevel !== path ||
                movedGit.commonDir !== join(path, '.git')
              )
                throw new Error('Workspace Git metadata cannot be relocated safely');
            }
            for (const file of [
              ...instructionFiles,
              '.repo-cloak/manifest.json',
              '.codex/config.toml',
              '.mcp.json',
              '.repo-cloak/agent/token',
              '.repo-cloak/agent/connection.json',
              '.repo-cloak/agent/SKILL.md',
              '.repo-cloak/agent/.gitignore',
              '.git/info/exclude',
            ]) {
              const full = join(path, file);
              item.backups.set(
                file,
                (await exists(full))
                  ? { bytes: await readFile(full), mode: (await lstat(full)).mode & 0o777 }
                  : undefined,
              );
            }
            for (const link of links) await rewriteLink(path, link);
            const snapshot = structuredClone(current);
            const legacy = !snapshot.data.guidance;
            if (legacy) await installGuidance(path, snapshot);
            if (legacy || snapshot.plain.extensions?.groupId) {
              snapshot.plain.extensions = { ...snapshot.plain.extensions, groupId: group.id };
              const manifest = await records.sealManifest(snapshot);
              await writeAtomic(join(path, '.repo-cloak/manifest.json'), manifest);
              const backupPath = join(
                store.root,
                'repos',
                target.repoId,
                'manifests',
                `${hashJson(workspaceId).slice(7)}.json`,
              );
              privateBackups.set(
                backupPath,
                (await exists(backupPath))
                  ? {
                      bytes: await readFile(backupPath),
                      mode: (await lstat(backupPath)).mode & 0o777,
                    }
                  : undefined,
              );
              await writeAtomic(backupPath, manifest);
            }
            if (!git) {
              const paths = [...Object.keys(snapshot.plain.files), '.repo-cloak/manifest.json'];
              const checkpoint = await prepareWorkspaceCheckpoint(
                path,
                paths,
                snapshot.data.guidance?.generated,
              );
              await checkpoint.commit('Initialize grouped cloak workspace');
            }
            await agents.relocate(workspaceId, target.path, path);
            await agents.ensure({
              repoId: target.repoId,
              workspaceId,
              path,
              worktree: snapshot.data.source.path,
            });
            if (legacy) {
              await writeAtomic(join(path, '.repo-cloak/agent/SKILL.md'), agentSkill);
              await writeAtomic(join(path, '.repo-cloak/agent/.gitignore'), '*\n');
            }
            await clients.relocate(workspaceId, target.path, path);
            await records.relocateWorkspace(target.repoId, workspaceId, target.path, {
              ...previous,
              path,
              groupId: group.id,
            });
            item.registered = true;
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
        for (const item of moves.reverse()) {
          try {
            const { target } = item;
            if (!item.moved) {
              if (await exists(item.path)) await rmdir(item.path);
              continue;
            }
            for (const [file, backup] of item.backups) await restore(join(item.path, file), backup);
            for (const link of item.links) await rewriteLink(item.path, link, true);
            if (!item.hadGit) await rm(join(item.path, '.git'), { recursive: true, force: true });
            if (await exists(target.path))
              throw new Error('Original workspace path is occupied; moved files retained', {
                cause: error,
              });
            await moveDirectory(item.path, target.path);
            if (item.hadAgent) {
              const doc = await agents.read(target.workspaceId);
              if (doc?.path === item.path)
                await agents.relocate(target.workspaceId, item.path, target.path);
            } else
              await store.remove(`agents/${target.workspaceId}.json`).catch((error) => {
                if (errorCode(error) !== 'ENOENT') throw error;
              });
            if (item.registered)
              await records.relocateWorkspace(
                target.repoId,
                target.workspaceId,
                item.path,
                item.previous,
              );
          } catch (failure) {
            failures.push(failure);
          }
        }
        for (const [path, backup] of privateBackups) {
          try {
            await restore(path, backup);
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
            `Group move rollback failed; recovery folder: ${folder}`,
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
