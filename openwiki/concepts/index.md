# Files

- [Anonymizer engine](anonymizer-engine.md) - How repo-cloak replaces names, regex matches and secrets in file contents and paths, keeps every replacement reversible through a ledger, verifies each file round-trips, and restores workspace edits (including newly written code) without leaving anonymized text behind.
- [Profiles, rules and file patterns](profiles-and-file-patterns.md) - What a repo-cloak profile contains, how literal, regex and secret rules are validated, how several global and repo profiles are combined without conflicts, the profile subcommands, and how gitignore-style exclude/include patterns decide which files can ever be copied.
