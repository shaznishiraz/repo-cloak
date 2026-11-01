# Build plan

Terminal workflows in earlier completed steps are historical and superseded by
[dashboard-first consolidation](design/dashboard-first.md). The current application
uses the dashboard for workflow actions.

The order v2 is built in. Each step lists its tasks and the **acceptance
scenarios** that must pass; every scenario becomes at least one Vitest test.
Tick boxes as work lands. 🏁 marks a milestone: update the OpenWiki there.

Designs: [overview](design/overview.md) ·
[data model](design/data-model.md) · [CLI](design/cli.md) ·
[web UI](design/web-ui.md)

## Progress

| Step | What                                  | Status    |
| ---- | ------------------------------------- | --------- |
| 0    | Scaffold                              | ✅ Done   |
| 1    | Store, crypto, repo identity, schemas | ✅ Done   |
| 2    | Profiles                              | ✅ Done   |
| 3    | Replacement engine                    | ✅ Done   |
| 4    | Cloak: source -> workspace 🏁         | ✅ Code   |
| 5    | Restore: workspace -> source 🏁       | ✅ Code   |
| 6    | Interactive mode                      | ✅ Code   |
| 7    | Web UI 🏁                             | ✅ Code   |
| 7a   | Dashboard sync wizard 🏁              | ✅ Code   |
| 8    | Release 2.0.0                         | ⏳ Checks |
| R0   | Dashboard rebuild: foundation         | ✅ Code   |
| R1   | Dashboard rebuild: screens            | ⏳ Checks |

---

## Step 0. Scaffold ✅

- [x] TypeScript, tsup, Vitest, ESLint, Prettier
- [x] `repo-cloak` / `cloak` bins, version and description from `package.json`

**Acceptance**

- **WHEN** the user runs `cloak --help` **THEN** the output matches
  `repo-cloak --help` and names the program `repo-cloak`.
- **WHEN** the user runs `repo-cloak -v` or `--version` **THEN** it prints the
  `version` from `package.json` and exits 0.
- **WHEN** the user runs `repo-cloak --help` **THEN** it prints usage, the
  package description, and the version and help options.

## Step 1. Store, crypto, repo identity, schemas

Design: [data-model.md](design/data-model.md) (files at a glance, sealed
envelope, encryption, tooling).

- [x] Add `zod`; schema module with `kind`, `schemaVersion`, `extensions`
- [x] `adapters/crypto`: create/load key (0600), `seal` / `open` with AES-256-GCM, `keyId`
- [x] `adapters/store`: resolve `~/.repo-cloak`, read/write sealed and plain files atomically
- [x] `core`: `repoId` from the canonical git common dir; schema version checks and migrations hook
- [x] `adapters/git`: find the repo top-level
- [x] Build writes `schemas/*.schema.json`; `package.json` `files` includes `schemas`
- [x] `repo-cloak schema <kind>`

**Acceptance**

- **WHEN** no key exists **THEN** one is created with 32 random bytes and mode 0600.
- **WHEN** data is sealed then opened **THEN** the original is returned exactly.
- **WHEN** a sealed blob or its plain part is altered **THEN** opening fails.
- **WHEN** a file was sealed with a different key **THEN** the error names the `keyId`.
- **WHEN** the same repo is reached through a symlink **THEN** its `repoId` is the same.
- **WHEN** two worktrees of one repo are resolved **THEN** they share one `repoId`.
- **WHEN** a file has a newer `schemaVersion` than supported **THEN** loading fails with a clear message.
- **WHEN** a file has unknown fields **THEN** they are kept on save.
- **WHEN** the user runs `repo-cloak schema profile` **THEN** it prints valid JSON Schema.

## Step 2. Profiles

Design: [data-model.md](design/data-model.md) (profile), [overview.md](design/overview.md)
(profile merge and validation), [cli.md](design/cli.md) (`profile`).

- [x] `core/rules`: literal, regex, secret rule types; validate a profile
- [x] `core/merge`: combine profiles, dedupe, detect conflicts
- [x] Profile storage in the store (global and per repo), sealed
- [x] `profile list | show | create | edit | delete | export | import | check`

**Acceptance**

- **WHEN** two rules in one profile share an `id` **THEN** validation fails naming the id.
- **WHEN** a regex rule does not compile **THEN** validation fails naming the rule.
- **WHEN** the same profile is selected twice **THEN** the run fails.
- **WHEN** two profiles map one original to different values **THEN** it fails naming both profiles and rules.
- **WHEN** two profiles map different originals to one value **THEN** it fails (push could not reverse it).
- **WHEN** two profiles contain an identical rule **THEN** it is deduplicated without error.
- **WHEN** a profile is imported from stdin **THEN** it is validated, sealed, and listed.
- **WHEN** a global and a repo profile share a name under `--yes` **THEN** the command fails asking for `--global` or `--repo`.

## Step 3. Replacement engine

Design: [anonymizer.md](design/anonymizer.md),
[data-model.md](design/data-model.md) (reversibility, secrets).

- [x] Word splitting and case-style variants (both sides)
- [x] Aho-Corasick matcher via `ahocorasick` in `core/`; longest match wins
- [x] Boundary modes `token`, `word`, `anywhere`; `forms`, `except`, suffixes
- [x] Verify pass: restore(anonymize(file)) == file, else abort
- [x] Preview data: replaced and skipped matches per rule
- [x] Regex rules with capture groups; secret detectors from a built-in catalog
- [x] Ledger of concrete pairs; restore from the ledger
- [x] `core/paths`: anonymize and restore file paths

**Acceptance**

- **WHEN** text is anonymized then restored **THEN** it equals the original (round trip).
- **WHEN** `Acme` and `AcmeCorp` are both rules **THEN** `AcmeCorp` is replaced as a whole.
- **WHEN** a rule is `Acme Corp` -> `Northwind Traders` **THEN** `AcmeCorp`, `acmeCorp`, `acme_corp`, `ACME_CORP`, `acme-corp` each become the same style of `Northwind Traders`.
- **WHEN** the rule is `Acme` in `token` mode **THEN** `getAcmeToken` and `ACME_API` match and `Acmeology` does not.
- **WHEN** the rule is `Ion` **THEN** `Function` is unchanged.
- **WHEN** the agent writes `NorthwindTradersClient` in the workspace **THEN** restore gives `AcmeCorpClient`.
- **WHEN** two rules produce the same variant **THEN** validation fails naming both.
- **WHEN** restored text still contains an anonymized word or placeholder in any casing **THEN** the restore stops and names the file and line.
- **WHEN** a restore replaces forms not in the ledger **THEN** the preview lists them as new.
- **WHEN** two original paths would map to one anonymized path (including case-only differences) **THEN** the cloak is refused.
- **WHEN** a regex rule matches `acme-billing-svc` **THEN** the ledger records the concrete pair.
- **WHEN** a secret is detected **THEN** it becomes a stable placeholder and is restored on push.
- **WHEN** the source already contains an anonymized value **THEN** pull is refused with the files listed.

## Step 4. Cloak: source -> workspace 🏁

Design: [overview.md](design/overview.md), [data-model.md](design/data-model.md)
(manifest, recorded automatically), [cli.md](design/cli.md) (`pull`).

- [x] `core/selection`: union of files, commits, working changes, extra paths
- [x] `adapters/git`: files in commits, working changes (`-z` output)
- [x] `adapters/files`: bounded parallel I/O, binary detection, hashing
- [x] `core/manifest`: build plain + sealed parts
- [x] Repo record: workspaces, last profiles, suggestions
- [x] CLOAK flags on `push` (source) and `pull` (workspace), `--dry-run`, `--yes`
- [x] First `push` in a worktree creates the workspace in `workspacesRoot` or `--to`

**Acceptance**

- **WHEN** `--commit a --working --files x` are combined **THEN** the union is pulled once per file.
- **WHEN** a pull completes **THEN** no original name or path appears in plaintext in the workspace.
- **WHEN** `--dry-run` is used **THEN** nothing is written.
- **WHEN** pull runs again in a workspace **THEN** it reuses the recorded source and profiles.
- **WHEN** a recorded profile changed since the last pull **THEN** the user is shown the change and asked.
- **WHEN** a binary file is pulled **THEN** it is copied unchanged.

**Milestone documentation:** OpenWiki regeneration is pending. The local
`openwiki code --update --print` command requires `OPENAI_API_KEY`, which is
not available in this session. Generated pages were left untouched; rerun the
generator with credentials or use the scheduled workflow after committing.

## Step 5. Restore: workspace -> source, and status 🏁

Design: [overview.md](design/overview.md) (push), [cli.md](design/cli.md)
(`push`, `status`, `workspaces`).

- [x] `repo-cloak status` from plain manifest hashes
- [x] Preflight: plan writes, detect conflicts; all or nothing
- [x] Restore contents and paths from the ledger; create, update, delete
- [x] Push from the source repo with `--from` or a prompt
- [x] `--skip-conflicts`, `--force`, `--dry-run`, `--yes`; exit code 2 on conflicts
- [x] `repo-cloak workspaces`
- [x] Restore into a new worktree with `--new-worktree`, `--base`, and `--path`

**Acceptance**

- **WHEN** a workspace file is unchanged **THEN** push skips it.
- **WHEN** a source file changed since the pull **THEN** push writes nothing, lists it, and exits 2.
- **WHEN** `--skip-conflicts` is used **THEN** all other files are pushed.
- **WHEN** a new file is created in the workspace **THEN** push creates it at the restored path.
- **WHEN** a file is deleted in the workspace **THEN** push asks before deleting it in the source.
- **WHEN** push runs in a source repo with two linked workspaces **THEN** it asks which one.
- **WHEN** a new worktree is requested **THEN** its base defaults to the extracted commit, and all tracked workspace files are restored.
- **WHEN** a new-worktree restore is dry-run or cancelled **THEN** no worktree or branch is created.
- **WHEN** a new-worktree restore fails during a file or manifest write **THEN** files and manifest are rolled back and the new worktree and unchanged branch are removed.
- **WHEN** `--base` and `--path` are supplied **THEN** the new target uses that commit and directory.

**Milestone documentation:** OpenWiki regeneration has the same credential
limitation recorded under step 4; generated pages remain untouched.
Restore supports existing and newly created worktrees. New-worktree planning
reads commit data directly and leaves the source worktree unchanged.

## Step 6. Interactive mode

Design: [overview.md](design/overview.md) (interactive flow).

- [x] Detect location: cloak workspace, known source repo, new repo
- [x] Infer the source repository and exact launch worktree; ask for context only outside Git
- [x] Profile multi-select with create-new, validated live
- [x] Selection (tree, commits, working changes, extra paths), destination suggestions, preview
- [x] Typed commit IDs, short IDs, branches and tags, checked against the repo as you type

**Acceptance**

- **WHEN** `repo-cloak` runs in a cloak workspace **THEN** it offers push, re-pull, and UI.
- **WHEN** it runs in a known source repo **THEN** the last-used profiles and workspaces are suggested first.
- **WHEN** it runs in a new git repo **THEN** the repo is registered before continuing.
- **WHEN** it runs outside any repository **THEN** it asks for the source repository path before anything else.
- **WHEN** launched inside a source worktree or its subdirectories **THEN** it skips repository/worktree questions and links the workspace to that exact branch.
- **WHEN** launched outside Git and the selected repository has several worktrees **THEN** it asks which worktree to use.
- **WHEN** the dashboard is selected after choosing a source outside Git **THEN** it opens with that source/worktree context.
- **WHEN** a typed commit ID is not in the repository **THEN** the prompt rejects it and asks again; duplicates of recent selections are ignored.

The UI entry starts the machine-wide dashboard. Other actions route through
the existing sync/status commands. The file picker is
a tree-shaped list of eligible file paths. Non-terminal bare invocation shows
help, and scripts use explicit commands.

## Step 7. Web UI 🏁

Design: [web-ui.md](design/web-ui.md).

- [x] `node:http` server, static assets, JSON API over existing commands
- [x] Session token, `127.0.0.1` only, `Host` / `Origin` checks
- [x] Screens: workspaces, profile list and editor, pull history
- [x] Isolated dashboard browser regression suite and CI reports

**Acceptance**

- **WHEN** an API call has no valid token **THEN** it is rejected.
- **WHEN** a request has a foreign `Origin` **THEN** it is rejected.
- **WHEN** a profile is saved in the UI **THEN** it passes the same validation as the CLI.
- **WHEN** the UI assets are built **THEN** they total under 98 KB.

**Milestone documentation:** OpenWiki regeneration remains pending the
credentials described under step 4. Generated pages were left untouched.

## Step 7a. Dashboard sync wizard 🏁

Design: [dashboard-sync.md](design/dashboard-sync.md), including the agreed
context-first setup refinement. Acceptance tests cover each implementation slice.

- [x] Extract shared prepare/apply stages while preserving CLI behavior
- [x] Preserve exact launch worktree, including reuse of an existing dashboard
- [x] Add validated worktree and bounded file/commit selection APIs
- [x] Add in-memory preview lifecycle, stale checks, apply state and duplicate protection
- [x] Add create-workspace wizard with profile editing, selection and destination
- [x] Add update-workspace and restore-to-source flows, including new worktrees
- [x] Add conflict choices, explicit acknowledgements and result/status refresh
- [x] Extend isolated browser regression coverage and update README usage
- [x] Run required checks, build/package smoke checks and UI asset budget check

- [x] Start at folder selection using inferred launch context; keep worktree changes optional
- [x] Browse source folders and local destination directories from the dashboard
- [x] Save global workspace-root and post-create-command defaults
- [x] Run setup commands once after creation; report failures without undoing the workspace
- [x] Organize selection into files/folders, uncommitted changes, and a searchable commit dialog
- [x] Search paths live across folders, preserve selections, and reject empty first-run selection
- [x] Show directional Pull/Push actions and tracked-file/change stats after setup
- [x] Expand nested file checklists in place with folder selection and partial-selection indicators
- [x] Center dialogs, remember light/dark appearance, and remove raw selection fields
- [x] Use one fresh Git-aware inventory request with a default-on ignore checkbox and explicit Refresh
- [x] Build descendant lists once and render collapsed children only on expansion
- [x] Load working changes/commits independently; verify local-only browser traffic
- [x] Simplify the dashboard to a repository rail and workspace cards, with Pull/Push, inline pull history, and collapsible workspace details
- [x] Delete entire cloak workspaces with confirmation, source/store protections, writer locks and registration/manifest cleanup

**Acceptance**

- **WHEN** the picker opens **THEN** one fresh inventory request loads eligible tracked and nonignored untracked paths; search/expansion make no further inventory requests.
- **WHEN** ignore rules are disabled **THEN** ignored paths become selectable while repo-cloak exclusions remain enforced; reenabling removes newly hidden paths from selection.
- **WHEN** Refresh is clicked or the picker reopens **THEN** current paths are read again without a persisted inventory.
- **WHEN** a nested filename is searched **THEN** matches appear without a Load click, and changing the query retains selected paths.
- **WHEN** commits are chosen **THEN** a searchable checkbox dialog confirms selections or discards cancelled changes.
- **WHEN** first-run selection is empty **THEN** Continue stays on selection with an actionable message.
- **WHEN** UI opens from a secondary worktree, including dashboard reuse **THEN**
  that exact worktree is selected; other worktrees remain selectable.
- **WHEN** a registered repo has no workspace **THEN** the wizard can select or
  create scoped profiles, choose eligible files/working changes/commit refs and
  an external destination, preview, then create a linked workspace.
- **WHEN** commits are selected **THEN** changed paths use current worktree bytes,
  matching the CLI; invalid refs or empty selections show actionable errors.
- **WHEN** profiles share names across scopes **THEN** explicit references select
  the intended profiles; existing conflict and exclusion validation still applies.
- **WHEN** a preview is requested, edited, cancelled or expires **THEN** it writes
  no sync files, key, configuration, locks, branches or worktrees; apply is unavailable
  for invalid, expired or cancelled previews.
- **WHEN** refresh applies **THEN** unchanged workspace files update, workspace-only
  edits survive, both-side edits conflict, and changed profiles require acknowledgement.
- **WHEN** restore applies **THEN** saved rules restore names and new/deleted paths,
  source edits remain uncommitted, and status/history refresh appropriately.
- **WHEN** restore targets an existing or new worktree **THEN** repo identity and
  detached-HEAD rules match the CLI; new targets are created only after confirmation.
- **WHEN** files, inventories, manifest, profiles, HEAD/branch or destination change
  after preview **THEN** apply refuses without writes and requests another preview.
- **WHEN** conflicts exist **THEN** default apply is blocked; skip/force choices
  create a fresh preview, and forced overwrites require explicit acknowledgement.
- **WHEN** deletes or profile changes are shown **THEN** apply requires the relevant
  explicit acknowledgements for that operation.
- **WHEN** apply is double-clicked, retried after a lost response or overlaps another
  operation **THEN** it executes once or returns busy; status remains queryable.
- **WHEN** a write or new-worktree restore fails **THEN** existing rollback guarantees
  hold and the UI distinguishes failure from successful writes with record-save errors.
- **WHEN** preview limits are exceeded or the server restarts **THEN** the UI reports
  the condition clearly, releases expired buffers and requires a fresh preview.
- **WHEN** new API routes receive invalid tokens, foreign origins, cross-repo IDs
  or unsafe paths **THEN** they reject requests; secret contents never enter previews.
- **WHEN** the browser wizard runs at desktop and 390-pixel widths **THEN** back,
  profile-editor return, validation, confirmation and results remain usable.
- **WHEN** validation runs **THEN** typecheck, lint, Vitest, browser regressions,
  build/package checks and the existing 98 KB UI asset budget pass.

- **WHEN** a launch identifies a source worktree without its own available workspace
  **THEN** setup starts with folder selection, even when another worktree already
  has a workspace; the optional Change control exposes other worktrees.
- **WHEN** settings save a root and setup commands **THEN** future creations inherit
  them; selecting or previewing never changes the defaults.
- **WHEN** new workspace creation succeeds **THEN** setup commands run once in that
  workspace; refresh/restore do not run them, and failure keeps the workspace.
- **WHEN** the folder picker opens **THEN** source navigation stays within the repo,
  while destination navigation can select external machine folders.

**Milestone documentation:** generated wiki refresh remains pending the existing
scheduled workflow after these changes are committed. Generated pages are untouched.

## Step 8. Release 2.0.0

- [x] README rewritten for v2, with a note that v1 workspaces must be pushed with v1 first
- [x] `npm view repo-cloak-cli version` is below `2.0.0`
- [x] `npm pack --dry-run` contents reviewed
- [x] Enforce backend/core coverage floors and built-package smoke checks before publication
- [ ] Confirm the final commit passes the macOS, Windows, and Linux CI matrix
- [ ] Refresh the generated OpenWiki for the completed milestones
- [ ] Publish only when the user asks

Release preparation checked npm version `1.3.4` on 2026-10-17. The package
preview contains the CLI, source map, three UI assets, six schemas, README,
license and package metadata. The local suite passes on Node 22.13.1 and Node
24; the final cross-platform CI run awaits pushing the commits. OpenWiki still
needs the credentials or scheduled workflow described under step 4. Publication
has not been requested.

## Dashboard-first consolidation

Design: [dashboard-first](design/dashboard-first.md).

- [x] Bare launcher opens dashboard directly with detected repo/worktree context.
- [x] Dashboard source registration, profile import/export and older commit selection.
- [x] Quick-sync review for deletions/profile changes; advanced restore target control.
- [x] Remove terminal-only commands/prompts and dependency; move shared application services.
- [x] Update launcher/API coverage, package checks and active documentation.
- [x] Scope automatic setup to the exact source worktree, ignore missing workspace
      folders, and recover saved sync entries before opening the file picker.
- [x] Add repository removal from the sidebar, detach group memberships, retain
      saved setup/files for re-adding, and invalidate removed-repository previews.

## Repository groups

Design: [repository groups](design/repository-groups.md). Approved, including
single-member groups and joining an existing group from the launch repository.

- [x] Add sealed group schema/store, validation, revision checks and CRUD coverage.
- [x] Add combined preflight, member acknowledgements, ordered application queue,
      idempotent status and partial-failure/retry coverage.
- [x] Add compact group navigation, editor, member repair and Pull all/Push all.
- [x] Move workspaces into shared folders, preserving edits/Git history,
      workspace identities/credentials/queues, rollback coverage and root guidance.
- [x] Add Finder/Explorer, VS Code and Zed actions for groups and workspaces;
      verify authenticated target allowlists and installed-app detection.
- [x] Keep local dependencies/cache artifacts out of Push, inherit profile file
      eligibility, and invalidate approval when exclusions change before writing.
- [x] Verify individual actions, exclusions, missing members and required backend/
      package checks; add and typecheck the browser regression scenario.
- [ ] Execute the new group browser scenario at desktop and 390px widths in
      both themes. BrowserOS tools are not connected in this session.

## Agent file requests

Design: [agent file requests](design/agent-file-requests.md). Approved, including
automatic guidance on creation, optional names, multiple workspaces, and MCP
connection setup controls.

- [x] Add exact anonymized-path resolution, public probe outcomes and protection
      policy with the acceptance tests in design step 1.
- [x] Add workspace-scoped credentials, encrypted queues, isolated HTTP routes,
      idempotency, quotas and revocation with authorization/leakage tests.
- [x] Add owner queue review/rejection and selective approval/pull, including
      stale approval checks, group views and crash reconciliation tests.
- [x] Add managed agent guidance/skill templates for new and existing workspaces;
      preserve user instructions and exclude generated data from source/export.
- [x] Add a thin MCP adapter, actual stdio package smoke test, and tested Codex
      project/Claude local configuration helpers; validate the generated skill.
- [x] Remove the duplicate Requests Policy editor and saved request-only rules;
      inherit selected global/repository profiles and repository exclusions, with
      regression coverage for legacy grants and exclusion changes before approval.
- [ ] Execute the live browser/client walkthrough with desktop/mobile and both
      themes. BrowserOS is not connected; no personal client settings are edited
      during automated tests.

## Workspace history and Orca

Design: [workspace history and Orca](design/workspace-history.md).

- [x] Always initialize new cloak workspaces and moved legacy workspaces as Git repositories.
- [x] Checkpoint successful Pull/Push with the sealed manifest; preserve unrelated
      staged work and roll back file/index changes on checkpoint failure.
- [x] Add authenticated Open -> Add to Orca with literal arguments and clear
      missing-CLI/runtime errors; verify supported CLI grouping/archive options.
- [x] Cover creation, repeated sync, excluded helpers, failed checkpoints and
      desktop argument handling; run required checks and build/package validation.

## Group moves

Design: [shared group folder](design/repository-groups.md#shared-folder-with-moved-workspaces).

- [x] Replace copying with filesystem moves and stable workspace IDs/credentials/queues.
- [x] Retarget internal absolute links and recognized workspace MCP configuration.
- [x] Restore directories, metadata and registration on failure; reject cross-filesystem
      moves and moving members out of another active physical group.
- [x] Update UI/docs and cover moves, reuse, connection preservation and rollback;
      run required checks and package validation.

### Explicit workspace placement

Design: [explicit placement and safe joining](design/repository-groups.md#explicit-placement-and-safe-joining).

- [x] Default new workspaces to standalone and explicitly select an existing group
      during creation; preserve group choice during operation recovery.
- [x] Append through a revision-checked, idempotent join route that preserves names
      and existing members; reserve replacement and renaming for Edit group.
- [x] Guard standalone roots/destinations against nested group folders, recover
      legacy defaults, and prefer source worktree context over containing groups.
- [x] Keep ungrouped sibling workspaces visible and retain the newly added source
      worktree in navigation; add regression coverage for isolation and stale state.
      The browser side of this section went with the old dashboard; package 20-new-cloak
      and 10-home rebuild it.
- [x] Run required checks and build/package verification; typecheck the new browser
      placement and join regression scenarios.
- [ ] Execute the new browser placement scenario when BrowserOS is available;
      BrowserOS tools are not connected in this session.

## Prompt library and repository packages

Design: [prompt library](design/prompt-library.md). Proposed; awaiting design
agreement before implementation, as required by AGENTS.md.

- [ ] Agree the compact library, repository inheritance and creation-time
      injection design, including fixed workspace snapshots.
- [ ] Add core prompt/package validation and deterministic resolution tests.
- [ ] Add sealed library storage, locking/revision checks and owner CRUD APIs;
      cover referenced deletions, limits and scoped-agent authorization failures.
- [ ] Add repository assignments and linked-worktree inheritance coverage.
- [ ] Add previewed creation injection, protected guidance stripping and rollback;
      verify snapshots survive Pull/Push, export, requests and group moves.
- [ ] Add compact Prompts/Packages management, tag filtering, assignments and
      optional creation selection; cover desktop/mobile browser interactions.
- [ ] Run required checks and build/package budget checks; document live browser
      availability and validation limits.

## Dashboard rebuild: foundation

Plan: [00-foundation](rebuild/INDEX.md#00-foundation). Design:
[rebuilt dashboard](design/web-ui.md#rebuilt-dashboard-foundation).

- [x] Serve a Preact + signals shell from `dist/web/`, with the
      existing server security model and no new runtime dependencies.
- [x] Add design tokens and accessible primitives; enforce 4.5:1 contrast by test.
- [x] Add the top bar, rail, hash router, a placeholder per route and the ⌘K palette
      with a command registry.
- [x] Add v2 contracts, typed client, polling helper, route table,
      `GET /api/v2/session` and `GET /api/v2/overview` with real counts.
- [x] Add the hash-chained audit log; wire create, pull, push, delete, agent decisions,
      settings and key rotation; `verify()` reports the first broken link.
- [x] Add OS keychain storage, migration and resumable key rotation; a fake keychain
      round-trips and migrates in tests.
- [x] Add machine-wide org policy with optional Ed25519 signature; a policy locks a
      setting and locked exclusions cannot be overridden.
- [x] Replace the MCP SDK with a minimal stdio server; the package smoke test passes and
      `npm ls --omit=dev` shows no SDK.
- [x] Pin versions; add `.npmrc`, SBOM, the CI audit gate, generated supply-chain
      numbers and the 160 KB budget test.
- [x] Verify the shell in a real browser: counts, every route, ⌘K, token removal,
      390px layout, CSP. Linux and Windows keychain backends are tested with fakes only.
- [x] Remove the vanilla dashboard, its `/api/*` routes and the `--next-ui` flag ahead of
      cutover; keep their behaviour tests at the application layer and give every removed
      capability a v2 route in `contracts.ts`.

## Dashboard rebuild: screens

Plan: [10-50](rebuild/INDEX.md#10-home--workspaces-home--group-sync). Design:
[rebuilt screens](design/web-ui.md#rebuilt-screens).

- [x] Merge 10-home, 20-new-cloak, 30-push, 40-profiles and 50-admin; remove placeholders.
- [x] Fold package-local types into `contracts.ts`; move auto-lock start to `main.tsx`.
- [x] Persist pins; add the first-run redirect and the `#/new` deep link.
- [x] Run every browser spec against one config, in its own server run.
- [x] Cover cross-package flows in `e2e/integration.e2e.ts`: Home approve, worktree link,
      folder browsing, first-run profile.
- [ ] Agree the shipped-asset budget. The build is ~247 KB against the agreed 160 KB, so
      `tests/scripts/build-web.test.ts` and `release:check` fail until this is decided.
- [ ] 90-cutover remainder and 99-review.

- [x] Hardening 65: workspace Git config guard, more secret detectors and warnings, lasting
      audit signing key, SBOM with bundled packages, pinned Actions, CodeQL, Dependabot.

Known gaps, engine or contract work not done:

- Home: bulk runs use a custom sequence in `server-v2/home.ts` without `groups.locked`;
  bulk rules live in localStorage; "Pull from commit" reads the worktree, not the commit;
  the leak guard only checks ledger values.
- New cloak: no `pull` CLI command, so that line is labelled planned; "Never pull" presets
  sit in a reserved global profile.
- Push: all-or-nothing, no per-file selection and no post-check command; `push.ts` should
  be split.
- Profiles: a catastrophic regex can stall the server; presets duplicate New cloak's.
- Workspace Git: the config check runs just before each Git call, so a process writing
  `.git/config` in that instant can still win. Only a sandbox closes this.
- Audit: a failed write does not stop the operation, and restoring an old log with its old
  head is only caught by comparing against an earlier export.
- Admin: default profiles are read-only; advisories and
  SBOM are copy commands; wipe on delete is unavailable. Known repos and New cloak each
  have their own `FolderPicker`.
- Windows is untested; Linux and Windows keychains are tested with fakes only.
