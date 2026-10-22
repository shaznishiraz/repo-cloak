# Files

- [CLI entrypoint and command routing](cli-program.md) - How the repo-cloak CLI starts, which commands it registers, how push and pull route to extraction or restore depending on where they run, the global --json/--yes flags, exit codes, and the loader seams tests replace.
- [Machine store, encryption and repository identity](store-and-encryption.md) - Where repo-cloak keeps its machine-local data, how profiles, repo records and workspace manifests are sealed with AES-256-GCM, how document versions are checked and migrated, how writes stay atomic, and how a repository is identified across worktrees.
