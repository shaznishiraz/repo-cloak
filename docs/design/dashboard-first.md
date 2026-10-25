# Dashboard-first application

```text
repo-cloak / cloak [--port N] [--no-open]
  -> detect source repo / worktree / cloak workspace (no terminal prompts)
  -> register source and launch/reuse local dashboard
  -> choose code -> profiles -> destination / commands -> review -> create
  -> Pull / Push -> review deletions, profile changes and conflicts -> apply

src/program.ts -> adapters/launcher.ts
                       -> application/dashboard*.ts
                       -> application/sync.ts -> core/ <- adapters/
```

Remove terminal selection, profile editing, sync/status/schema subcommands,
confirmation prompts and their runtime dependency. Keep a `ui` launcher alias,
help/version, port selection and browser suppression. Reject obsolete commands
without executing an operation. Package and bin names remain unchanged.

The optional `agent-mcp` mode is a stdio transport for scoped file-request tools,
not a return of terminal sync/profile workflows. See [agent requests](agent-file-requests.md).

Launching from a source worktree with no available cloak workspace for that exact
worktree opens setup at the file picker, even when other worktrees of the same
repository have workspaces. The overview exposes each workspace's recorded target
worktree (falling back to its origin for older records). Missing workspace folders
do not count as configured. Explicit cloak-workspace and group links keep their
normal views. Recover saved operations before deciding whether to open setup.

Repository removal is a reversible dashboard action:

```text
repository row -> trash icon -> DELETE /api/repos/:id
  -> shared operation queue (refuse while syncing)
  -> detach from groups; discard empty groups
  -> seal hidden=true in the repository record
  -> reload sidebar and select an available repository/group

Add source / launch from source -> register -> clear hidden -> restore saved links
```

Keep source/workspace directories, profiles, exclusions, manifest backups and
workspace links. Hidden repositories are excluded from dashboard lists and sync
targets; pending previews fail revalidation after removal. Do not automatically
restore group membership when the repository is added again. Show the row's trash
icon on hover or keyboard focus, and keep it visible on touch devices. Removal is
available for missing source folders too and needs no filesystem deletion.

Move shared orchestration from `commands/` to `application/`. All syncing is a
prepare/preview plus explicit apply operation; only dashboard operation approvals
permit writes. Keep conflict checks, encryption, exclusions, locks, rollback,
post-create commands and repo/worktree identity checks.

Close dashboard parity gaps before removing the terminal route:

- Add an existing source repo through the folder picker; reject cloak workspaces.
- Import a profile JSON file into the chosen scope; export profile JSON locally.
- Allow commit refs beyond the recent list and page through source commit history.
- Route quick-sync deletions/profile changes/conflicts to the review screen.
- Expose existing new-branch/worktree restore support under an advanced control.

Profile export is explicitly decrypted JSON. No profile/file data is uploaded to
an external service. Source registration and all API writes require the existing
local session token. Existing stores and workspaces remain compatible.
