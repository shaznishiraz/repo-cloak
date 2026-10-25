# Sync through the dashboard

```text
source repository -> Create workspace / Pull files -> cloak workspace
source repository <- Push changes (restore names)  <- cloak workspace
```

The launcher keeps the exact source worktree when started in a repository or a
subdirectory. Inside a cloak workspace, its sealed manifest identifies the source
and workspace. Outside Git, the dashboard can register a source through the folder
picker. **Change worktree** selects another worktree of that registered repo.

The application always prepares a plan before applying it. Preview reads source
and workspace state without writes, exposes paths/counts/warnings, and identifies
profile changes and conflicts. The authenticated operation API handles expiry,
explicit acknowledgements, cancellation and idempotent apply. Files and identities
are rechecked under writer locks. See [dashboard-sync](dashboard-sync.md).

Pull combines selected files, working paths, commit paths and previously tracked
paths. Repository exclusions are applied before reads and win over profiles.
Profile changes are merged and validated before content/path anonymization. The
ledger and original paths remain sealed. Every new workspace initializes its own
Git repository; post-create commands run after a successful create only. Successful
Pull and Push checkpoint the affected cloak files and sealed manifest, preserving
unrelated staged changes. Legacy workspaces initialize Git on their next sync.
See [workspace history](workspace-history.md) for rollback and Git failure behavior.

Push resolves original paths from the saved manifest/ledger. It processes edits,
additions and deletions while protecting source changes since the baseline.
Conflict handling is block, skip, or explicitly acknowledged force. Quick actions
route deletions, changed profiles and conflicts to the dashboard review screen.

Restore can target an existing worktree, or create a new branch/worktree. The new
branch defaults to the extraction commit; the advanced restore controls can
specify a base and destination. Planning reads Git objects without creating a
worktree. Apply creates it under the existing safeguards and rolls it back when
writes fail. Captured uncommitted changes are included in the full restore.

Registered repositories share identity across worktrees through Git's common
directory. Workspace records preserve origin and target branches; moved worktrees
are resolved by branch and identity rather than trusting obsolete paths.

Shared orchestration lives in `src/application/`. The launcher and browser are
entry points; neither contains replacement or write-safety logic. See
[dashboard-first](dashboard-first.md) for the removal of terminal workflows.
