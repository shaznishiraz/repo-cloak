# Repository groups

Status: implemented. A group can start with one member so a
backend workspace can join immediately and a frontend workspace can be added later.
Launch from either repository, create a workspace if needed, then use Add to group.

Group related source repositories (for example backend and frontend) without
merging their Git histories or cloak manifests. Repository registration and
individual workspace creation already exist. Each member explicitly chooses
one cloak workspace and source worktree; never guess from the most recently used
workspace. One repository may participate in multiple groups.

```text
Repositories                  Storefront             [Pull all] [Push all]
  Storefront                  Source -> cloak         Cloak -> source
    backend                   ------------------------------------------
    frontend                  backend / api-cloak      [Pull] [Push]
  Other repositories          Profiles: API           Ready
                              frontend / web-cloak     [Pull] [Push]
                              Profiles: Web           Ready

Create group
  Name: [Storefront                  ]
  [x] backend   Workspace [api-cloak v] Worktree [main v]
  [x] frontend  Workspace [web-cloak v] Worktree [main v]
                                      [Cancel] [Save group]
```

The repository rail gets collapsible group entries and an ungrouped section.
Selecting a group shows its members using the existing compact workspace card.
Place a New group folder icon in the repository header alongside Add repository; retain
New workspace in the selected repository heading. Long names truncate with a
full-name tooltip. No extra overview cards or duplicate counters.

## Persisted model

```ts
type RepositoryGroup = {
  kind: 'group';
  schemaVersion: 1;
  id: string; // generated UUID
  name: string; // trimmed, 1..80 characters
  folder?: string; // canonical root containing independent copied cloak workspaces
  members: Array<{
    repoId: string;
    workspaceId: string;
    worktree: string; // canonical registered source worktree
  }>;
};
```

Store each group at `~/.repo-cloak/groups/<id>.json`, sealed with the existing
AES-256-GCM store key and atomic writes. Extend document kinds and the sealed
store adapter explicitly; no plain path/name settings or duplicate repo records.
Use a group lock for updates, validate unique repo IDs and 1..8 members, and use a
revision/hash to reject stale edits. Batch preparation also
respects the shared memory limit.
Fresh stores need no migration. Existing repositories/workspaces stay compatible.

## Shared folder with independent copies

New groups created in the dashboard copy their selected **cloaked workspaces**
into a single directory. Existing logical groups offer Create group folder.
Original source repositories and original cloak folders stay in place.

```text
<cloak root>/group-<id>/
  AGENTS.md / CLAUDE.md           group instructions and member tool routing
  .codex/config.toml             one scoped MCP connection per copied workspace
  .mcp.json                      equivalent Claude project connections
  .repo-cloak/group.json         group ID and relative member folder names
  api-cloak/                    actual directory copy; new workspace ID/token
  web-cloak/                    actual directory copy; new workspace ID/token

select cloak workspaces -> validate identities and destination
  -> copy each directory (including local edits and standalone Git history)
  -> reseal manifests with fresh workspace IDs; issue fresh scoped credentials
  -> register copied workspaces -> save group pointing at the copies
  -> on failure, remove only newly created copies/records and restore owned files
```

Copy no source files during grouping. Recreate self-contained project links
inside each copy (including local dependencies); reject links outside the cloak
workspace, special files, external Git worktrees and local client connection files. Preserve
each copy's profiles, ledger, history, tracked baselines and unsynced edits.
Install agent guidance in copied legacy workspaces while preserving instruction
edits, tracked deletions and file baselines. Never reuse the original credential or queue.
Copying does not run Git hooks or post-create commands.
Untracked dependency/cache artifacts remain local: Push applies normal file
eligibility, including selected profile includes/excludes, and rechecks exclusion
changes under the writer lock. Inventory never follows project symlinks.

The group gets a stable, neutral directory name; member directory names derive
only from cloak folder names and receive a neutral suffix on collision. The
destination root is the configured cloak root (or beside the first cloak), outside
source repositories, existing workspaces, the owner store and other group folders.
Never overwrite an existing destination. Serialize grouping with sync, validate
copied manifests and keep an existing group's folder on edits. Retain its current
copies; only new/replaced members are copied. Saving edits refreshes the root
instructions and scoped connections. Removed copies stay registered and on disk,
including inside the folder. Removing a repository from the dashboard preserves
group-folder files too; hidden repositories refuse new file requests. Removal is
not a filesystem deletion or revocation of already shared files. Deleting a group
leaves its folder and workspaces intact.

Owner-only Reveal/Open actions accept registered workspace/group IDs and a fixed
target enum, never an arbitrary path or command. Reveal uses Finder/Explorer/the
system file manager; editors are VS Code and Zed. Detect installed editors, use
argument arrays (no shell), and show an actionable unavailable-app message.
Launching repo-cloak from the group root opens that group. Editor actions open
the group root; a single agent session can read both actual member directories.

Deleting a group removes its grouping record only. A missing/deleted workspace
remains visible as Needs setup; combined sync is disabled until repaired or
removed from the group. Validate every member against live registered identities
on save and every batch, including selected source worktree membership.

## Combined sync

```text
Pull all / Push all
  -> snapshot group revision + exact member targets
  -> prepare existing sync preview for EVERY member
  -> any invalid/conflicting member? show member review; write nothing
  -> deletions/profile changes? one review with acknowledgements per member
  -> otherwise apply immediately, matching individual quick sync
  -> server owns ordered queue; apply one member at a time
  -> show each member's result and overall progress in the existing status line
```

Reuse `createDashboardSync` prepare/apply, `createUiOperations`, repo writer
locks and existing file-state rechecks. Pull all means `refresh`, Push all means
`restore`, exactly matching dashboard buttons. Retain each member's profiles,
exclusions, replacement ledger and history; no group-wide profile override.
Individual Pull/Push continues through the same pipeline.

Represent a batch as one operation in the existing operation manager, with the
sum of its members' preview bytes and per-member summaries/status. The manager's
single-running-operation guard then protects the whole ordered batch. Recheck
all members before the first write and again inside each existing writer.

All previews must be applicable before starting. Never auto-acknowledge
deletions, profile changes or force. Edits to a group invalidate pending batches.
Cancel/failed preparation releases already-prepared member previews. Freeze group
membership while applying. The batch owns the application queue: reject individual
apply attempts while it runs, rather than bypassing the operation manager's
existing single-running-operation guard. Preflight source/destination overlap and
reject batches whose member write/read trees overlap.

Independent Git repositories have no shared transaction. If backend succeeds and
frontend fails or becomes stale at apply, keep backend's successful result, stop
the queue and report `1 succeeded / 1 failed` (remaining members unattempted).
Existing rollback applies inside the failed member only. Retry prepares fresh
previews for failed/unattempted members; never replay successful members. A lost
response can be polled/retried idempotently by batch ID. Server restart expires
in-memory batches; reload member status and prepare again, without automatic replay.

## Boundaries and API

- `core/`: group schema, validation, batch state types; no I/O.
- `adapters/groups.ts`: sealed persistence, group lock and revision checks.
- `application/dashboard-groups.ts`: CRUD and batch orchestration using current
  dashboard sync services; expose through authenticated server routes.
- `GET/POST /api/groups`; `PUT/DELETE /api/groups/:id` with revision checks.
- `POST /api/groups/:id/preview` with direction and group revision returns a
  batch ID and member summaries; no writes.
- `POST /api/group-sync/:batchId/apply` with per-member acknowledgements starts
  the server queue, returning promptly; `GET` polls state; `DELETE` cancels pending
  batches only. Repeated apply observes the same batch and never executes twice.
- Browser renders group CRUD, member repair, review and per-member progress.
  Reuse existing session/origin checks; batch IDs cannot authorize foreign members.
- `copyWorkspaces: true` on group save creates the physical folder (or reuses its
  current copies); optional `folderRoot` chooses its parent. Legacy API callers
  can keep logical groups. The dashboard enables copying by default.
- `GET /api/desktop` reports installed openers; `POST /api/groups/:id/open` and
  `POST /api/workspaces/:repoId/:workspaceId/open` take only `target` (`folder`,
  `vscode`, `zed`). Group/source paths and shell commands cannot be supplied.

The generic single-workspace apply route rejects group-owned operation IDs, so
it cannot bypass per-member review. Reload recovers a running batch by ID from
session storage. Preparing a batch holds no filesystem locks or persisted plans;
membership is checked against its revision again before apply. Preview expiry and
memory/queue limits are enforced by the shared operation manager.

## Acceptance

- Register backend/frontend, create their workspaces, group them and retain the
  group across restart. Group CRUD never writes repository contents.
- Group selection exposes combined actions and each member's individual actions.
- Pull all and Push all preserve independent profiles, exclusions and histories.
- A missing member, invalid identity, overlapping target, conflict or exceeded
  operation/memory limit writes nothing during preflight and releases previews.
- Review acknowledgements remain per member and per prepared operation.
- Concurrent apply/double-click/lost responses execute each member at most once.
- Apply-time failure stops remaining members and reports partial success; retry
  excludes completed members and prepares fresh state for the others.
- Removing a group preserves repositories/workspaces; deleting a member workspace
  shows Needs setup without silently selecting a different target.
- At 390px and desktop widths, long names truncate, actions remain visible and
  modal fields/footer maintain consistent spacing in both themes.

The grouped navigation, editor and batch review retain the existing vanilla UI
and add no runtime dependencies. Keep the shipped browser assets below the
current 92 KB cap, enforced in build tests and package smoke checks.

The generated local MCP configuration follows the official
[Codex project configuration](https://developers.openai.com/codex/config-basic/).
Projects must be trusted for Codex to load their local configuration. Editor
launch behavior follows the [VS Code CLI](https://code.visualstudio.com/docs/configure/command-line)
and [Zed CLI](https://zed.dev/docs/reference/cli).
