import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { createAgentStore } from '../adapters/agent-store.js';
import { createStore } from '../adapters/store.js';
import { createProfileStore } from '../adapters/profiles.js';
import { createSyncStore } from '../adapters/sync-store.js';
import { checkDestinationPath, checkSourceDestination, filterPaths } from '../adapters/files.js';
import { errorCode } from '../adapters/atomic.js';
import { runGit } from '../adapters/git.js';
import { canonicalPath } from '../adapters/locations.js';
import type { createDashboardSync } from './dashboard-sync.js';
import { MAX_AGENT_FILE_BYTES, requestPath } from '../core/agent-requests.js';
import type { AgentDocument, AgentRequest, ProbeState } from '../core/agent-requests.js';
import { compilePatterns } from '../core/patterns.js';
import { hashJson } from '../core/hash.js';
import { validateRelativePath, restorePaths, anonymizePaths } from '../core/paths.js';
import { createReplacer } from '../core/replacer.js';

const pathsSchema = z.array(requestPath).min(1).max(100);
const submission = z
  .object({
    clientRequestId: z.string().min(1).max(100),
    paths: pathsSchema.max(20),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
const selection = z.object({ paths: z.array(requestPath).min(1).max(20) }).strict();
const publicRequest = (request: AgentRequest) => ({
  id: request.id,
  files: request.files.map(({ path, state }) => ({ path, state })),
});

export function createAgentRequests(
  store: ReturnType<typeof createStore>,
  sync: ReturnType<typeof createDashboardSync>,
) {
  const access = createAgentStore(store);
  const records = createSyncStore(store);
  const profiles = createProfileStore(store);
  const rates = new Map<string, { start: number; count: number }>();
  const previews = new Map<string, { workspaceId: string; requestId: string; revision: string }>();
  async function context(doc: AgentDocument) {
    await records.requireUsablePolicy();
    const target = await sync.workspaceTarget(doc.repoId, doc.workspaceId);
    if (
      target.path !== (await canonicalPath(doc.path)) ||
      target.snapshot.data.source.path !== doc.worktree
    )
      throw new Error('Source worktree changed; reconnect agent access');
    if (!(await sync.worktrees(doc.repoId)).some((tree) => tree.path === doc.worktree))
      throw new Error('Source worktree unavailable');
    const repo = await records.readRepo(doc.repoId);
    if (!repo) throw new Error('Repository unavailable');
    const selected = await Promise.all(
      target.snapshot.data.profiles.map(async (ref) => {
        const profile = (await profiles.list(ref.scope)).find((profile) => profile.id === ref.id);
        if (!profile) throw new Error('A saved profile is unavailable');
        return profile;
      }),
    );
    return { ...target, repo, selected };
  }
  function limit(doc: AgentDocument, kind: string, max: number) {
    const now = Date.now();
    for (const [key, value] of rates) if (value.start + 60_000 < now) rates.delete(key);
    const key = `${doc.workspaceId}:${kind}`;
    const value = rates.get(key) ?? { start: now, count: 0 };
    if (++value.count > max) throw new Error('Request limit reached');
    rates.set(key, value);
  }
  async function probe(doc: AgentDocument, paths: string[]) {
    const ctx = await context(doc);
    const deny = compilePatterns([
      ...(ctx.repo.exclude ?? []),
      ...ctx.selected.flatMap(({ profile }) => profile.exclude ?? []),
    ]);
    const replacer = createReplacer(ctx.snapshot.data.rules);
    const results: Record<string, ProbeState> = Object.create(null) as Record<string, ProbeState>;
    const candidates: { input: string; path: string; original: string; size: number }[] = [];
    for (const input of paths) {
      results[input] = 'unavailable';
      try {
        const path = validateRelativePath(
          isAbsolute(input) ? relative(doc.path, input).split('\\').join('/') : input,
        );
        if (deny(path)) {
          results[input] = 'not_allowed';
          continue;
        }
        const mapped = ctx.snapshot.data.files[path]?.path;
        const original =
          mapped ?? restorePaths([path], replacer, ctx.snapshot.data.ledger).paths[0]?.original;
        if (!original) continue;
        if (
          deny(original) ||
          !filterPaths(
            [original],
            ctx.selected.map((profile) => profile.profile),
            ctx.repo.exclude ?? [],
          ).length
        ) {
          results[input] = 'not_allowed';
          continue;
        }
        const roundtrip = anonymizePaths([original], replacer, ctx.snapshot.data.ledger).paths[0]
          ?.anonymized;
        if (roundtrip !== path) continue;
        await checkDestinationPath(doc.path, path);
        try {
          if ((await lstat(join(doc.path, path))).isFile()) {
            results[input] = 'already_present';
            continue;
          }
        } catch {
          /* Missing local files are candidates. */
        }
        if (mapped) continue; // A deleted, previously shared file is a normal workspace edit.
        await checkSourceDestination(doc.worktree, original);
        for (
          let folder = original.split('/').slice(0, -1);
          folder.length;
          folder = folder.slice(0, -1)
        ) {
          try {
            await lstat(join(doc.worktree, ...folder, '.git'));
            throw new Error('Nested repository');
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
        }
        const info = await lstat(join(doc.worktree, original));
        if (!info.isFile()) continue;
        if (
          info.size > MAX_AGENT_FILE_BYTES ||
          /\.(png|jpe?g|gif|webp|pdf|zip|gz|exe|dll|woff2?|sqlite3?|db)$/i.test(original)
        ) {
          results[input] = 'not_allowed';
          continue;
        }
        candidates.push({ input, path, original, size: info.size });
      } catch {
        /* Never expose original names or filesystem diagnostics to the agent. */
      }
    }
    if (candidates.length) {
      const eligible = new Set(
        (
          await runGit(doc.worktree, [
            '--literal-pathspecs',
            'ls-files',
            '--cached',
            '--others',
            '--exclude-standard',
            '-z',
            '--',
            ...candidates.map((item) => item.original),
          ])
        ).split('\0'),
      );
      for (const item of candidates)
        if (eligible.has(item.original)) results[item.input] = 'available';
    }
    return { results, available: candidates.filter((item) => results[item.input] === 'available') };
  }
  async function requireDoc(id: string) {
    const doc = await access.read(id);
    if (!doc) throw new Error('Enable agent requests for this workspace first');
    return doc;
  }
  async function reconcile(doc: AgentDocument) {
    const snapshot = await records.readSnapshot(doc.path);
    let changed = false;
    for (const request of doc.requests)
      for (const item of request.files) {
        const proof = snapshot?.plain.pulls.find((pull) => {
          const ext = pull.extensions as
            { agentRequestId?: string; agentRequestPaths?: string[] } | undefined;
          return ext?.agentRequestId === request.id && ext.agentRequestPaths?.includes(item.path);
        });
        if (proof && item.state !== 'pulled') {
          item.state = 'pulled';
          changed = true;
        }
      }
    if (changed) await access.write(doc);
    return doc;
  }
  return {
    authenticate: access.authenticate,
    refreshDescriptors: access.refreshDescriptors,
    async agentCall(doc: AgentDocument, route: string, value: unknown) {
      limit(
        doc,
        route === 'probe' ? 'probe' : route === 'requests' ? 'submit' : 'status',
        route === 'requests' ? 10 : 120,
      );
      if (route === 'info')
        return {
          workspaceId: doc.workspaceId,
          maxFileBytes: MAX_AGENT_FILE_BYTES,
          maxRequestFiles: 20,
        };
      if (route === 'probe')
        return {
          results: (
            await probe(
              doc,
              pathsSchema.parse(z.object({ paths: pathsSchema }).strict().parse(value).paths),
            )
          ).results,
        };
      if (route === 'requests') {
        const input = submission.parse(value);
        return access.locked(doc.workspaceId, async () => {
          const current = await requireDoc(doc.workspaceId);
          if (!current.enabled || current.tokenHash !== doc.tokenHash)
            throw new Error('Access revoked');
          const payloadHash = hashJson({
            paths: [...new Set(input.paths)].sort(),
            reason: input.reason,
          });
          const existing = current.requests.find(
            (request) => request.clientRequestId === input.clientRequestId,
          );
          if (existing) {
            if (existing.payloadHash !== payloadHash) throw new Error('Request key already used');
            return publicRequest(existing);
          }
          if (
            current.requests.filter((request) =>
              request.files.some((item) => item.state === 'pending' || item.state === 'failed'),
            ).length >= 10
          )
            throw new Error('Pending request limit reached');
          const checked = await probe(current, input.paths);
          const unique = new Map(checked.available.map((item) => [item.path.toLowerCase(), item]));
          if (!unique.size) return { id: null, results: checked.results, files: [] };
          const request: AgentRequest = {
            id: randomUUID(),
            clientRequestId: input.clientRequestId,
            payloadHash,
            reason: input.reason,
            createdAt: new Date().toISOString(),
            files: [...unique.values()].map(({ path, original, size }) => ({
              path,
              original,
              size,
              state: 'pending',
            })),
          };
          while (current.requests.length >= 50) {
            const index = current.requests.findIndex((item) =>
              item.files.every((file) => file.state === 'pulled' || file.state === 'rejected'),
            );
            if (index < 0) throw new Error('Request retention limit reached');
            current.requests.splice(index, 1);
          }
          current.requests.push(request);
          await access.write(current);
          return { ...publicRequest(request), results: checked.results };
        });
      }
      const id = z.uuid().parse(route);
      return access.locked(doc.workspaceId, async () => {
        const current = await reconcile(await requireDoc(doc.workspaceId));
        const request = current.requests.find((request) => request.id === id);
        if (!request) throw new Error('Request unavailable');
        return publicRequest(request);
      });
    },
    async info(repoId: string, workspaceId: string) {
      await sync.workspaceTarget(repoId, workspaceId);
      return access.locked(workspaceId, async () => {
        const doc = await access.read(workspaceId);
        if (!doc || doc.repoId !== repoId)
          return {
            enabled: false,
            guidance: !!(await sync.workspaceTarget(repoId, workspaceId)).snapshot.data.guidance,
            requests: [],
          };
        await reconcile(doc);
        // Advisory only: approving re-checks. A moved worktree or deleted profile must not stop
        // the owner seeing and rejecting what is queued, so fall back to the repo's exclusions.
        const ctx = await context(doc).catch(() => undefined);
        const repo = ctx?.repo ?? (await records.readRepo(doc.repoId));
        const excluded = compilePatterns([
          ...(repo?.exclude ?? []),
          ...(ctx?.selected ?? []).flatMap(({ profile }) => profile.exclude ?? []),
        ]);
        return {
          enabled: doc.enabled,
          guidance: true,
          requests: doc.requests.map((request) => ({
            ...request,
            files: request.files.map((file) => ({
              ...file,
              excluded: excluded(file.path) || excluded(file.original),
            })),
          })),
          worktree: doc.worktree,
        };
      });
    },
    async configure(repoId: string, workspaceId: string, value: unknown) {
      const input = z
        .object({
          enabled: z.boolean(),
          rotate: z.boolean().optional(),
        })
        .strict()
        .parse(value);
      const target = await sync.workspaceTarget(repoId, workspaceId);
      if (input.enabled && !target.snapshot.data.guidance)
        throw new Error(
          'Pull this workspace once to install agent guidance before enabling access',
        );
      return sync.operations.exclusive(async () => {
        if (
          input.enabled &&
          (!(await access.read(workspaceId)) ||
            input.rotate ||
            !(await requireDoc(workspaceId)).enabled)
        )
          await access.ensure(
            { repoId, workspaceId, path: target.path, worktree: target.snapshot.data.source.path },
            true,
          );
        await access.locked(workspaceId, async () => {
          const doc = await access.read(workspaceId);
          if (!doc) return;
          doc.enabled = input.enabled;
          await access.write(doc);
        });
        return { enabled: input.enabled };
      });
    },
    async reject(repoId: string, workspaceId: string, requestId: string, value: unknown) {
      const input = selection.parse(value);
      await sync.workspaceTarget(repoId, workspaceId);
      return sync.operations.exclusive(() =>
        access.locked(workspaceId, async () => {
          const doc = await requireDoc(workspaceId);
          if (doc.repoId !== repoId) throw new Error('Wrong repository');
          const request = doc.requests.find((item) => item.id === requestId);
          if (!request) throw new Error('Request unavailable');
          const rejected: string[] = [];
          for (const item of request.files)
            if (
              input.paths.includes(item.path) &&
              item.state !== 'pulled' &&
              item.state !== 'rejected'
            ) {
              item.state = 'rejected';
              rejected.push(item.path);
            }
          await access.write(doc);
          await sync.audit.record({
            op: 'agent-deny',
            outcome: 'ok',
            workspace: { repoId, id: workspaceId },
            files: rejected.map((path) => ({ path })),
            detail: `Request ${requestId}`,
          });
          return publicRequest(request);
        }),
      );
    },
    async preview(repoId: string, workspaceId: string, requestId: string, value: unknown) {
      const input = selection.parse(value);
      const doc = await requireDoc(workspaceId);
      if (!doc.enabled || doc.repoId !== repoId)
        throw new Error('Agent access is disabled or belongs to another repository');
      const request = doc.requests.find((item) => item.id === requestId);
      if (!request) throw new Error('Request unavailable');
      const items = request.files.filter(
        (item) => input.paths.includes(item.path) && ['pending', 'failed'].includes(item.state),
      );
      if (!items.length || items.length !== new Set(input.paths).size)
        throw new Error('Select pending files from this request');
      const checked = await probe(
        doc,
        items.map((item) => item.path),
      );
      if (
        items.some(
          (item) =>
            checked.results[item.path] !== 'available' ||
            checked.available.find((value) => value.path === item.path)?.original !== item.original,
        )
      )
        throw new Error('Requested files or exclusions changed; review a new request');
      if (checked.available.reduce((sum, item) => sum + item.size, 0) > 10 * 1024 * 1024)
        throw new Error('Request batch exceeds 10 MiB');
      const revision = hashJson({ files: items, tokenHash: doc.tokenHash });
      const preview = await sync.operations.preview(async () => {
        const raw = await sync.prepareOperation(
          {
            intent: 'refresh',
            repoId,
            workspaceId,
            worktree: doc.worktree,
            files: items.map((item) => item.original),
          },
          {
            exactFiles: true,
            maxFileBytes: MAX_AGENT_FILE_BYTES,
            requestId,
            requestPaths: items.map((item) => item.path),
          },
        );
        if (
          !raw.summary.canApply ||
          raw.summary.profileChanges.length ||
          raw.summary.deletes.length ||
          raw.summary.writes.some((path) => !items.some((item) => item.path === path))
        )
          throw new Error(
            'Refresh changed profiles or resolve workspace conflicts separately before approving requests',
          );
        return {
          ...raw,
          owner: 'agent-request' as const,
          async apply() {
            const latest = await requireDoc(workspaceId);
            const current = latest.requests.find((item) => item.id === requestId);
            const selected = current?.files.filter((item) => input.paths.includes(item.path)) ?? [];
            if (
              !latest.enabled ||
              revision !== hashJson({ files: selected, tokenHash: latest.tokenHash })
            )
              throw new Error('Request approval is stale');
            const fresh = await probe(
              latest,
              items.map((item) => item.path),
            );
            if (items.some((item) => fresh.results[item.path] !== 'available'))
              throw new Error('Request exclusions or source changed');
            try {
              const result = await raw.apply();
              await access.locked(workspaceId, async () => {
                await reconcile(await requireDoc(workspaceId));
              });
              await sync.audit.record({
                op: 'agent-approve',
                outcome: 'ok',
                workspace: { repoId, id: workspaceId },
                files: items.map((item) => ({ path: item.path })),
                detail: `Request ${requestId}`,
              });
              return result;
            } catch (error) {
              await access.locked(workspaceId, async () => {
                const record = await reconcile(await requireDoc(workspaceId));
                const failed = record.requests.find((item) => item.id === requestId);
                for (const item of failed?.files ?? [])
                  if (input.paths.includes(item.path) && item.state === 'pending')
                    item.state = 'failed';
                await access.write(record);
              });
              await sync.audit.record({
                op: 'agent-approve',
                outcome: 'failed',
                workspace: { repoId, id: workspaceId },
                files: items.map((item) => ({ path: item.path })),
                detail: `Request ${requestId}`,
              });
              throw error;
            }
          },
        };
      });
      for (const id of previews.keys()) {
        try {
          sync.operations.status(id);
        } catch {
          previews.delete(id);
        }
      }
      previews.set(preview.operationId, { workspaceId, requestId, revision });
      return { ...preview, selected: checked.available.map(({ path, size }) => ({ path, size })) };
    },
    async apply(repoId: string, workspaceId: string, operationId: string) {
      const entry = previews.get(operationId);
      const doc = await requireDoc(workspaceId);
      if (doc.repoId !== repoId || entry?.workspaceId !== workspaceId)
        throw new Error('Request preview unavailable');
      return sync.operations.apply(operationId, {}, 'agent-request');
    },
  };
}
