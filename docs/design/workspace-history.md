# Workspace history and Orca

Approved scope: standalone Git history for every cloak workspace, checkpoints on
successful Pull/Push, and an explicit Add to Orca action in the Open menu.

```text
Create / Pull -> workspace lock -> recheck -> prepare standalone cloak Git
  -> write anonymized files + sealed manifest -> commit affected cloak paths
Push -> workspace + source locks -> recheck -> prepare cloak checkpoint
  -> restore source files + update sealed manifest -> commit cloak paths
  -> update private record; source edits remain uncommitted

Open -> Add to Orca -> resolve installed CLI -> repo add --path <cloak> --json
```

Git initialization is mandatory, including legacy workspaces on their next sync
and moved legacy group members. Accept legacy `initGit` configuration but ignore its value.
Use the `cloak` branch for a new repository; preserve existing standalone history.
Pull records affected files, deletions and the encrypted manifest. Push records
the eligible, non-conflicting cloak files and manifest. Preserve unrelated staged
changes and refuse overlapping staged changes. Generated instructions, scoped
credentials and local client configuration are excluded. Never commit the source.
The first checkpoint of a legacy workspace includes its managed files.

Git failures roll source/workspace writes, index and managed Git exclusions back
together. A later private-record failure keeps a successfully committed snapshot.
Group moves preserve the existing workspace identity and Git history; legacy
folders without Git receive an initial checkpoint. Rollback uses standard
Git tooling: restore files and `.repo-cloak/manifest.json` together in the same
workspace; keep local credentials and the owner store. No destructive rollback
button or automatic source rollback is introduced.

Desktop targets add `orca` alongside folder/VS Code/Zed. Execute arguments
literally with no shell, using the CLI resolution from the Orca skill:
`ORCA_CLI_COMMAND`, else `orca-dev` for a development session, else `orca-ide` on
Linux, else `orca`. Use only registered cloak/group paths. Groups register their
container folder; member repositories keep independent Git histories. Missing
CLI and runtime/command failures have distinct actionable messages.

The installed Orca CLI's `repo add --help` and `agent-context --json` confirm
`repo add --path <path> --json`. They expose no repository group/archive placement
command. Register only; do not edit Orca's private database or move cloak folders.
