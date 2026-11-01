# Dashboard rebuild — plan and work packages

Status: **00-50 merged; 90-cutover and 99-review remain**, see [plan](../plan.md#dashboard-rebuild-screens). Designs: [`design/`](design/README.md).

## Decisions

- **Keep the engine.** `core/`, `application/`, `adapters/` (strict TS, 43 test files,
  AES-256-GCM sealing, reversible ledger, worktree/group logic) stay. No Rust rewrite:
  slices are tens to hundreds of files, so speed is not the bottleneck; correctness is.
- **Rebuild the dashboard fresh** in `src/web/` with **Preact + @preact/signals**, TSX,
  bundled by the existing tsup/esbuild into `dist/web/`. Both are devDependencies and
  get bundled, so the published package gains **no runtime dependency**.
  New shipped-asset budget: **160 KB** minified (JS+CSS+HTML), enforced by test.
- **CLI + local browser stays the product.** `repo-cloak` in a worktree opens the
  dashboard on that context. A Tauri desktop shell may wrap `dist/web/` later; screens
  must only talk to the local HTTP API so that stays possible.
- **The old UI is already gone.** `src/ui/` and `--next-ui` were removed at foundation
  rather than at cutover; see "Removed ahead of cutover" below.
- **Everything local.** Loopback only, session token, Host/Origin checks, CSP `'self'`,
  no telemetry, no CDN fonts. The only outbound call is an advisory check the user
  clicks in Settings.

## Order

```
00-foundation  (one agent, must merge first)
      |
      +--> 10-home   20-new-cloak   30-push   40-profiles   50-admin   (parallel, own worktrees)
      |
      v
90-cutover + hardening  (one agent)  -->  99-review (fresh agent, has not seen the code)
```

Each package: branch `rebuild/<id>` from the merged foundation, own worktree under
`.worktrees/<id>`. Touch only the files you own; if you need a shared file changed,
note it in your PR description for the foundation owner instead of editing it.

Done = `npm run typecheck && npm run lint && npm test && npm run build` green, new
tests for every acceptance item, design matched at 1440px and usable at 390px.

---

## 00-foundation

Owns: `src/web/shell/**`, `src/web/tokens.css`, `src/web/api/**`, `src/web/main.tsx`,
`src/web/index.html`, `scripts/build-ui.ts`, `src/adapters/server.ts` (asset + v2 route
plumbing only), `src/adapters/agent-mcp.ts`, new security modules below, `package.json`,
`.npmrc`, CI.

1. **Web scaffold.** `src/web/` with Preact + signals, TSX (`jsxImportSource: preact`;
   add a `tsconfig` for web with `lib: ["ES2023","DOM"]`), build to `dist/web/`, served
   by default. Keep the existing server security headers and token flow
   (fragment token -> sessionStorage -> `Authorization: Bearer`).
2. **Tokens + primitives.** `tokens.css` from `design/README.md`. Primitives in
   `src/web/shell/ui/`: Button (primary/secondary/ghost/danger, split button with menu),
   Badge, Panel (header + body), Row list with selected state, Tabs/segmented, Field,
   Checkbox/Radio, Menu, Dialog, Toast, EmptyState, Mono text, Kbd. Accessible (real
   buttons/inputs/labels, focus rings, aria on icon buttons, 4.5:1 contrast).
3. **Shell.** Top bar (logo, launch context chip, search/⌘K, store-sealed chip, + Cloak),
   left rail (Workspaces, Known repos, Agent requests w/ count, Profiles, History,
   Settings, Groups list), hash router (`#/`, `#/new`, `#/ws/:id`, `#/ws/:id/push`,
   `#/groups/:id`, `#/repos`, `#/requests`, `#/profiles[/:id[/json]]`, `#/history`,
   `#/settings`, `#/setup`), placeholder screen per route that the screen packages
   replace. ⌘K palette (`design/Palette.dc.html`) with a command registry screens can
   add to; each command can expose its CLI equivalent.
4. **API contracts.** `src/web/api/contracts.ts` (types only, imported by server and web)
   for every v2 route the screens need; `src/web/api/client.ts` typed fetch with token,
   errors, and an SSE or polling helper for status refresh. Implement on the server only
   `GET /api/v2/session` and `GET /api/v2/overview` (launch context, groups, workspaces
   with status counts and lineage, pending agent-request count). Screen packages
   implement their own routes in `src/adapters/server-v2/<package>.ts` registered via a
   route table the foundation provides.
5. **Hash-chained audit log.** `core/audit.ts` (pure: event schema, canonical hash,
   `prevHash` chaining, verify) + `adapters/audit-store.ts` (append-only sealed JSONL in
   the store, fsync, retention). Events carry who/when/op/workspace/file paths+hashes/
   profile versions/keyId — never file contents. Wire pull, push, create, delete, agent
   request decisions, settings changes, key rotation. `verify()` reports first broken link.
6. **Key in OS keychain.** `adapters/keychain.ts`: macOS `security`, Linux
   `secret-tool`, Windows DPAPI via PowerShell; `execFile` only, no shell. Setting
   `keyStorage: auto|keychain|file`; `auto` uses keychain for new installs, keeps an
   existing key file working, and offers migration. Key rotation reseals the store and
   logs an audit event. Tests use a fake.
7. **Org policy.** `core/policy.ts` (zod schema: locked global exclusions, audit
   retention days, allow exclusion override, auto-lock minutes) + loader reading a
   machine-wide file the user can't write (`/Library/Application Support/repo-cloak/`,
   `/etc/repo-cloak/`, `%ProgramData%\repo-cloak\`), optional Ed25519 signature with a
   `policy.pub` next to it. Policy values override user config and are reported as locked.
8. **Drop the MCP SDK.** Replace `@modelcontextprotocol/sdk` with a minimal stdio
   JSON-RPC 2.0 MCP server (initialize, notifications/initialized, ping, tools/list,
   tools/call) keeping the same 4 tools, input limits and behaviour. Update
   `scripts/check-package.mjs` to drive it with a tiny local client. Expect the
   production tree to drop from ~127 packages to ~20.
9. **Supply chain.** `.npmrc` with `ignore-scripts=true` and `save-exact=true`; pin all
   versions; `npm run sbom` (`npm sbom --sbom-format cyclonedx --omit dev`); CI runs
   `npm audit --omit=dev --audit-level=moderate` and uploads the SBOM; Settings'
   supply-chain numbers come from a build-time generated JSON.
10. **Docs.** Update `docs/design/web-ui.md` and `docs/plan.md` for the above.

Acceptance: `repo-cloak` opens the shell with real counts from
`/api/v2/overview`; every route renders its placeholder; ⌘K opens and navigates;
audit chain verifies and detects a tampered line; keychain fake round-trips and
migrates; policy locks a setting; MCP smoke test passes without the SDK;
`npm ls --omit=dev` shows no MCP SDK; budget test enforces 160 KB.

---

### Removed ahead of cutover

`src/ui/`, the `/api/*` dashboard routes and `--next-ui` are gone, so until the screens
land the dashboard is the shell only. Read `git show 860f5c7:src/ui/app.js` for the old
behaviour. Keep the input checks the old routes did before calling `dashboard.*`: IDs
are `decodeURIComponent`ed by `route()`, but query numbers, booleans and JSON are yours.

| Capability                                        | Calls                                     | Owner |
| ------------------------------------------------- | ----------------------------------------- | ----- |
| Workspace detail, delete, open, desktop list      | `dashboard.workspace/deleteWorkspace`,    | 10    |
|                                                   | `dashboard.desktop.*`                     |       |
| Group CRUD, join, open, sync, retry, cancel       | `dashboard.groups.*`                      | 10    |
| Export commits, files and diff                    | `dashboard.sync.export*`                  | 10    |
| Selection, inventory, worktrees, commits          | `dashboard.sync.*`                        | 20    |
| Choose a group at creation; standalone by default | see `design/repository-groups.md`         | 20    |
| Folder browser, used by 20 and 50                 | `browseFolders`, offset is a whole number | 20    |
| Profiles, check, validate, JSON Schemas           | `dashboard.*Profile*`, `jsonSchema`       | 40    |
| Repos, remove, exclusions, settings               | `dashboard.*`, `dashboard.settings.*`     | 50    |
| Agent access, requests, MCP client setup          | `dashboard.agents.*`, `agentClientConfig` | 50    |

## 10-home — Workspaces home + group sync

Design: `Main.dc.html`, `GroupSync.dc.html`. Owns `src/web/screens/home/**`,
`src/web/screens/group/**`, `src/adapters/server-v2/home.ts`.

- Grouped workspace list with status badges (to push, source moved, clean, folder
  missing), "Needs action" filter, bulk pull/push per group.
- Detail: lineage strip (main repo -> worktree@sha -> cloak), 7-cell stat strip,
  Pull and Push split buttons with target menus (origin worktree default; main
  checkout; another worktree; new worktree from main; export .patch; dry run).
- Panels: pending changes (cloaked path -> restored path, +/-), guard checks, agent
  requests (approve/deny inline), history (last 4 events from audit log).
- Group page: members with per-repo push target, plan column, shared folder tree,
  bulk rules (stop all on guard failure, same commit message), last bulk runs.

## 20-new-cloak — New cloak + first run

Design: `NewCloak.dc.html`, `FirstRun.dc.html`. Owns `src/web/screens/new/**`,
`src/web/screens/setup/**`, `src/adapters/server-v2/new.ts`.

- Context banner (detected worktree/branch/ahead count; existing cloak -> Open / Add to it / New).
- One sheet: uncommitted (from git status), commits (picker + search older), files &
  folders tree from `git ls-files` with excluded nodes shown and locked; profiles chips;
  name + destination (locked when Settings says so); group select; post-create commands
  with variables `{dest} {source} {branch} {name} {group} {sha}`.
- Live review aside: files out / lines / held back, held-back list with rule, replacements
  with hit counts, path preview, leftover real-name warning (blocks create unless
  ignored), CLI equivalent, Create (⌘↵).
- First run: key, cloak root, exclusion presets, first profile (with suggested names).

## 30-push — Push review

Design: `PushReview.dc.html`. Owns `src/web/screens/push/**`, `src/adapters/server-v2/push.ts`.

- Target picker in header; file list with per-file flags (clean, source moved/auto-merge,
  new derived name); side-by-side "what Claude edited (cloak)" vs "what lands in source
  (restored)" plus restored-diff-only toggle; 3-way merge note with Merge / Pull first /
  Overwrite.
- Checks: every name restores, no cloaked name leaks into source, merges, manifest-only
  paths, optional post-check command. New derived names list.
- Write files / stage / commit with restored message; re-pull after push; include group
  members; backup of overwritten files kept 7 days with undo.

## 40-profiles — Profiles, rules, JSON

Design: `Profiles.dc.html`, `ProfilesJson.dc.html`. Owns `src/web/screens/profiles/**`,
`src/adapters/server-v2/profiles.ts`.

- List (scope, rule/exclusion counts), exclusion presets.
- Rules table: type (brand, keyword, business term, regex, secret), find, replace, case
  mode, hits; add-by-type buttons. Never-pull patterns (inherited global ones locked).
- Tester: paste text -> cloaked -> round trip check. Suggestions from last scan.
- JSON mode with schema validation, problems list, outline, "Paste from LLM" that diffs
  and refuses secret values.

## 50-admin — Known repos, agent requests, history, settings

Design: `KnownRepos.dc.html`, `AgentRequests.dc.html`, `History.dc.html`,
`Settings.dc.html`. Owns `src/web/screens/{repos,requests,history,settings}/**`,
`src/adapters/server-v2/admin.ts`.

- Known repos: pinned, worktrees from `git worktree list` with ahead/behind and Cloak/Open,
  repo rules (default profiles, extra exclusions, allowed roots), exposure stats.
- Agent requests: inbox with states, reason, policy check, cloaked preview, Approve &
  pull / signatures only / Deny / auto-approve pattern.
- History: audit table with filter syntax, event detail, verify chain, signed export.
- Settings: workspaces, security (keychain, auto-lock, override, wipe on delete),
  global exclusions, audit & compliance (retention, policy file status), supply chain,
  AI tools & editor. Policy-locked fields shown locked.

## 90-cutover + hardening

Check no capability in the table above was lost, complete the e2e journeys, accessibility pass, 390px pass, budget check, security headers re-check.

## 99-review

A fresh agent reviews all packages against this file and the designs, and against the
security rules above, and files findings before release.

## Compliance note

ISO/IEC 27001 certifies an organisation's ISMS, not software. This tool supplies
evidence for Annex A controls: access control (keychain, unlock, policy locks),
logging (hash-chained audit, retention, signed export), cryptography (AES-256-GCM,
key rotation), secure development and supply chain (SBOM, pinned deps, no install
scripts, advisory checks).
