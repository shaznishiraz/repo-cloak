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
