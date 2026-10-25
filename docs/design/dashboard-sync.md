# Dashboard sync wizard

Status: **agreed; implemented**. Includes the user-requested context-first refinement below.
Extends [web-ui.md](web-ui.md) and reuses [sync.md](sync.md).

## User flow

Run `repo-cloak ui` inside an existing project or Git worktree. Preserve that
exact worktree when opening or reusing the machine-wide dashboard. Offer a
new workspace wizard when none exists, and explicit directional actions for
linked workspaces. Repo identity alone cannot identify the launch worktree.

```text
repo-cloak ui -> repository + launch worktree
                     |
          +----------+-----------------------+
          |                                  |
     Create workspace                 Select linked workspace
          |                                  |
     Source folders/files            +--------+------------------+
          |                          |                           |
     Profiles + defaults         Update cloak workspace   Restore to source
          |                          |                           |
     Global workspace root      Source worktree +         Existing target or
          |                     optional selection       new branch/worktree
          +--------------------------+---------------------------+
                                     |
                        Preview direction, paths, deletions,
                        warnings, profile changes, conflicts
                                     |
                              Confirm -> Apply
                                     |
                         Result + refreshed status/history
```

Use these action labels rather than unqualified pull/push. Always show source
and destination. CLI direction semantics remain as defined in sync.md.
Commit selection chooses changed paths and reads their current worktree bytes,
matching the CLI; explain this beside the commit selector.

Reuse the existing profile editor with a return path to the wizard. Back retains
choices and invalidates a preview when choices change. Refresh defaults to
recorded files/profiles. Restore uses the authenticated extraction rules and
ledger, even if profiles were subsequently edited. Leave source edits uncommitted.

## Shared command boundary

Extract reusable prepare/apply stages from the existing command orchestration;
both the CLI and dashboard call them. Keep planners pure and keep current
writers, locks, rollback, collision checks and manifest handling. Do not spawn
CLI subprocesses or add sync logic to browser JavaScript.

```text
CLI prompts ---------+                      +-> workspace writer
                     +-> prepare -> apply --+
Dashboard API -------+      |               +-> source/worktree writer
                            v
                      core planners
```

The dashboard adapter supplies explicit selections and never prompts on stdin.
Missing or ambiguous choices return structured validation errors. Resolve
workspace IDs through the registered repo, canonicalize worktree paths, and
verify Git common-directory identity. First-run destination input is explicit
when no workspacesRoot exists; suggesting a path must not save configuration.

## Preview contract

```ts
type SyncIntent = 'create' | 'refresh' | 'restore';
type SyncPreview = {
  operationId: string;
  intent: SyncIntent;
  expiresAt: string;
  source: { path: string; branch: string | null };
  destination: { path: string; branch: string | null };
  writes: string[];
  deletes: string[];
  warnings: string[];
  conflicts: string[];
  profileChanges: string[];
  canApply: boolean;
  replacements: number;
  redactions: number;
  postCreateCommands: string[];
  forced: boolean;
};
```

Requests use a validated discriminated union for each intent, including repo,
workspace, worktree, scoped profile references, selection and target options.
Return summary counts for replacements and redactions on extraction; never
send secret values, decrypted ledgers or restored file bodies to the browser.

Keep prepared plans and captured inputs in server memory, keyed by a random
operation ID, for ten minutes. Limit pending previews to eight per server and
use an internal byte budget with a documented default of 64 MiB for all
pending previews; reject excess previews with a clear message. Release buffers
on expiry, cancellation, completion and shutdown. No persisted plaintext plans.

Apply accepts only the operation ID and explicit acknowledgements for deletions,
changed profiles and any selected conflict policy. It must apply the approved
plan, rather than silently rerun with `yes: true`. Under existing writer locks,
recheck source/workspace bytes and inventories, manifest, profiles, repository
identity, HEAD/branch and any resolved new-worktree base or destination. Stale
inputs invalidate the preview without writes and require another preview.

Conflicts block by default. Expose CLI-supported skip/force as advanced choices;
changing policy requires a fresh preview showing the affected paths. Apply
requires separate acknowledgement for forced overwrites. New worktrees and
branches are created only during apply, using existing rollback behavior.

Serialize applies in the dashboard for the initial implementation, reject
overlapping attempts as busy, and retain filesystem locks against CLI processes.
Repeated apply requests return the same operation state/result; they never
start a second write. Expired or cancelled IDs require a new preview. Closing a
tab does not interrupt an apply; reopening can query its state. Completed results
expire after ten minutes and are bounded to the most recent 32 operations.
Cancellation discards a pending preview; it does not abort an active writer.
If the server restarts, show unknown operation and refresh status before retrying.

## API additions

```text
GET    /api/repos/:repoId/worktrees       live worktree choices
GET    /api/repos/:repoId/selection       legacy paginated selection API
GET    /api/repos/:repoId/inventory       one fresh eligible path inventory, optional Git ignores
GET    /api/repos/:repoId/selection-context  working-change summary and recent commits
POST   /api/sync/preview                 validated intent -> summary + operation ID
GET    /api/sync/:operationId            pending/running/completed/failed state
POST   /api/sync/:operationId/apply      confirm the approved preview
DELETE /api/sync/:operationId           discard a pending preview
```

Use the existing bearer authentication, Host/Origin checks, request-size limits,
no-cache headers and text-only DOM rendering for every new route. Launch context
must carry the exact worktree through dashboard reuse and be validated server-side.
Return validation, conflict, stale, expired and busy errors distinctly. Poll
operation state during apply; no WebSocket or background daemon is needed.

## Scope and delivery

Keep the existing vanilla UI and dependencies. Measure the existing 96 KB asset
budget before implementing; split modules if useful, but retain the budget unless
a separately agreed design change raises it. Use step 7a in [plan.md](../plan.md)
for implementation order and acceptance scenarios. Update README usage once the
feature works. Publication and generated OpenWiki edits are outside this change.

## Context-first setup refinement

The user requested this refinement while implementation was in progress:

```text
launch from source/worktree -> inferred context (Change is optional)
  -> browse source folders/files -> profiles -> workspace defaults -> preview
  -> create under global workspacesRoot -> run post-create commands
  -> workspace dashboard: update / restore
```

Do not require a source or worktree question when launch context already identifies
it. Show that context with an optional Change control. First-run source context
opens setup directly; existing linked workspaces open their dashboard.

The source picker is a navigable directory tree with folder selection and eligible
file checkboxes, constrained to the selected worktree. A separate local directory
browser chooses machine folder paths for workspace roots and new-worktree targets;
it does not upload files or rely on browser directory handles. Typed paths remain
available, including not-yet-created destinations. Both APIs retain authentication
and validate paths on the server.

Settings expose `workspacesRoot` and optional `postCreateCommands: string[]`.
Creation inherits them, allows an override, and can save the choices for future
workspaces only after successful creation. Explicit Settings saves are independent
of preview; previews never save defaults. Roots must be outside Git repositories
and cloak workspaces. Preserve unknown config fields.

Post-create commands are user-configured shell commands, executed in order with
the new cloak workspace as cwd, after files and records are successfully saved and
locks released. Show the commands in the approval preview. They run once for new
workspace creation, never refresh/restore or preview. Each command has a two-minute
limit; stop at the first failure. Report per-command results without undoing the
created workspace or automatically retrying commands. Command output is not logged
or included in previews. CLI and dashboard use the same creation hook.

Add `GET /api/folders`, `GET /api/settings`, and `PUT /api/settings`. The selection
API takes a repo-relative directory and returns immediate subdirectories plus
paginated eligible files. Keep shipped UI assets under the existing 96 KB budget by minifying browser JavaScript with the existing tsup build tool; no frontend framework or new dependency is added. Source remains formatted for maintenance.

## Selection-first workflow refinement

User-requested interaction, retaining the prepare/apply contract above:

```text
Select code -> Profiles -> Destination -> Review & confirm
    |
    +-- Files & folders: live repository-wide search or paginated folder browsing
    +-- Uncommitted changes: individual paths or include all working changes
    +-- Commits: searchable checkbox dialog with explicit confirmation
    |
    +-- shared selection summary; remove paths/commits without starting over

Workspace -> Pull from source / Push to source -> preview -> confirm
             change counts + tracked file count + history
```

Selection sources combine. Searching changes the visible results, never the
selection. Empty create selections cannot advance; empty refresh selections reuse
recorded paths. Commit selection continues to read current worktree contents.
The file browser loads one bounded page at a time; opening a folder does not select
it. Selecting a folder explicitly includes its eligible descendants. Selection is made through the checklist and commit picker; raw selection fields
are removed by the appearance refinement below. Profile exclusions are
resolved by the server during preview, after profile selection.

## Expandable checklist and appearance

User-requested refinement:

```text
Files & folders -> searchable nested checklist
                    folder checkbox: select eligible descendants
                    expand/collapse: reveal children in place
                    partial selection: indeterminate folder checkbox
Commit/folder dialogs -> centered in the viewport
Appearance -> system default -> explicit light/dark toggle -> remember on this browser
```

Read only eligible path metadata through paginated selection requests, never file
contents. Keep selection independent of expansion and search. Folder selection
uses individual file paths so a child can be unchecked without reselecting its
parent. Remove raw path/commit text fields from setup; explicit CLI flags remain
available. Theme applies to dialogs, inputs, profile editing, notices and stats.

## Fresh Git-aware inventory

User-approved trial, without a persistent inventory cache:

```text
Open picker / Refresh / change ignore checkbox
  -> one authenticated inventory request
  -> Git tracked + nonignored untracked paths (default)
     OR filesystem listing with repo-cloak exclusions (ignore checkbox off)
  -> filter metadata, nested repositories and profile exclusions
  -> return eligible paths, never contents
  -> build hierarchy once; mount child rows only when expanded

Working changes + recent commits -> separate request, independent of inventory
```

`Respect Git ignore rules` defaults on and includes Git's standard ignore sources.
Tracked paths remain visible even when they match ignore patterns. Empty folders
are not part of the file checklist. When disabled, existing repo-cloak exclusions
still apply; `.git` and `.repo-cloak` metadata remain forbidden. Selecting a folder
still expands to explicit eligible file paths for preview. Paths hidden by a
checkbox change are removed from explicit selection and reported to the user.

Use a single fresh request for the inventory rather than rescanning each page.
Keep the inventory only in the active picker, never on disk or across openings.
Refresh and reopening read current state. Build folder descendant lists in one
pass, preserve expansion across UI navigation, and create collapsed children only
when opened. Search remains local to the loaded inventory and expands matching
branches. Refresh does not write source/workspace files. Normal extraction and
restore remain local; configured post-create shell commands retain their explicit
user-controlled behavior and may access the network.

## Workspace overview refinement

The user-requested minimal layout supersedes the earlier bento composition.
Keep the restrained accent, rounded workspace cards, and both themes. Remove
workflow and overview panels; selecting a source repository is the main navigation.

```text
Desktop                              Mobile
+----------------+----------------+  +---------------------------+
| Repositories   | Repo name      |  | Repositories (scroll row) |
| selected repo  | workspace count|  +---------------------------+
| other repo     | + New workspace|  | Repo name + new workspace |
|                | +------------+|  | +-----------------------+ |
|                | | Name     x ||  | | Name                x | |
|                | | Last used  ||  | | Last used             | |
|                | | Pull  Push ||  | | Pull      Push        | |
|                | | History    ||  | | History               | |
|                | | Details ▸  ||  | | Details ▸             | |
|                | +------------+|  | +-----------------------+ |
+----------------+----------------+  +---------------------------+
```

Default to the launch repository or first registered repository. Keep repository
workspace counts, but omit aggregate metrics and the all-repositories view. Load history on demand and keep it collapsed initially. Show the latest three
pulls, with earlier records behind a disclosure.
History uses a compact list of recorded pulls with dates and file counts. Do not
imply push history exists when the backend only records pulls. Keep source paths,
profile names and change details available without adding permanent card clutter.
Use consistent 18px inline SVG outline icons for repository navigation, sync,
history and utilities. Use a restrained orange accent for the primary Push action,
soft neutral secondary buttons, compact content-width sync buttons, rounded corners,
and visible keyboard focus in both themes. Keep Pull files and Push changes
visible as text; icon-only theme, refresh and delete controls need accessible
names and hover titles. History keeps a stable label and exposes expanded state.
Move New workspace into the repository heading. Show recorded profile names as
pills on each workspace. Truncate long repository and workspace labels, retaining
full names in hover titles. A local SVG cloak mark identifies the application.

Replace boxed notifications with an inline live status message. During real sync
work, an orange scanner line moves along the frame and the active button's icon
animates. Stop on completion, preview handoff, or error; retain readable error
text. Respect reduced motion, and prevent duplicate sync clicks while running.
No new API or sync semantics are introduced. Build-time JavaScript compression
keeps assets within the existing 96 KB limit without runtime dependencies.

Preview budget estimation counts binary backing buffers directly, shared references
once, and estimated JavaScript metadata overhead. It does not stringify selected
file buffers into JSON arrays merely to measure pending-plan size. Retain the
existing byte limit and rejection behavior; exact heap usage remains engine-dependent.

## Delete a cloak workspace

```text
Workspace card -> Delete -> confirm exact directory and unsynced-change warning
  -> authenticated DELETE /api/workspaces/:repoId/:workspaceId
  -> validate registration + authenticated manifest + independent directory
  -> workspace lock -> repo-record lock -> recheck
  -> rename workspace to a private sibling deletion directory
  -> remove registration + stored manifest copy -> remove renamed directory
  -> refresh cards and counts
```

Delete the full cloak directory, including its Git history and untracked edits.
Never accept a caller-supplied deletion target: the confirmed path must match the
registered workspace path. Protect source repositories/worktrees, the private
store, and overlapping registered workspaces; reject directory symlinks and
foreign/missing manifests on existing directories. Missing directories can be
unregistered. Keep source files, repo registration and saved profiles.

Use the same workspace lock as sync writers, then the repo-record lock. A busy
workspace rejects deletion. Registration failure after renaming restores the
original directory. If final removal fails, report the remaining deletion path;
never report success while files remain. No deletion is performed by GET routes.

## Export a selected commit diff

```text
Workspace card -> Export diff -> choose source commit
  -> list every changed source path with Git insertion/deletion counts
  -> anonymize paths for display; mark repository-excluded paths
  -> optionally override excludes for this export -> check files to include
  -> read only selected commit blobs locally -> apply saved workspace rules
  -> preview per-file red/green diffs -> copy selected anonymized patch
```

Export is read-only. It can inspect any changed file in a source commit, even if
that path is not in the workspace manifest. Repository exclusions stay enabled
by default and are never changed by Export; a separate explicit override permits
including those paths in this export only. The file list allows individual
selection, and only selected blobs are read for the preview. Diff metadata and
clipboard output contain anonymized paths and content, not commit IDs, subjects,
or blob hashes. Binary files are identified and omitted. Cap each file and the
combined preview size, and validate selected file indexes against the requested
commit on the server. The dashboard never sends source data to an AI service.
