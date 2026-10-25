# Agent file requests

Status: implemented. New workspaces receive managed guidance and scoped request
credentials automatically. Multiple workspaces per repository/worktree remain
supported. An optional workspace name chooses a neutral destination folder;
blank names retain automatic naming.

An agent in a cloak workspace can ask whether a specific anonymized file is
eligible, queue additional files with a reason, and observe the result. Only
the owner can approve and pull them through the dashboard. Repository groups
can aggregate the queue visually; credentials and approvals stay per workspace.

```text
Agent in backend-cloak
  |
  | probe [src/NorthwindContext.cs, schema.graphql, missing.ts]
  v
Workspace-scoped broker on 127.0.0.1
  -> validate literal paths inside this cloak workspace
  -> restore original paths privately using saved rules + ledger
  -> inherit selected profile/repository exclusions and enforce filesystem boundaries
  -> return available / not_allowed / unavailable (no source contents)
  |
  | request eligible files + reason
  v
Encrypted pending queue -----> Dashboard: Requests (3)
                                [x] NorthwindContext.cs   reason / size
                                [ ] AnotherFile.ts        reason / size
                                [Reject] [Preview selected]
                                               |
                                review + Approve & pull
                                               |
                                shared anonymizer / writer
                                               v
Agent polls request status <-- approved files appear in backend-cloak
```

## Scope and permissions

The HTTP API and thin stdio MCP transport share the same application service;
the transport does not implement separate lookup or sync logic.
Any agent with local HTTP access can use the first version through workspace
instructions. No external service is called and no source contents are returned
by these agent endpoints. Once approved files reach the workspace, the owner's
chosen agent may transmit them to its model provider as it normally would.

- Creation enables scoped requests for that workspace and source worktree.
  Existing workspaces install guidance through their next owner-initiated Pull.
  Connection controls enable/disable access and rotate credentials.
- Issue a revocable random capability token scoped to that workspace, source
  repository and worktree, with only `probe`, `request`, and `request-status`.
- Never give agents the machine-wide dashboard token, profile API, source
  inventory, export override, approvals, sync/apply API or another member's queue.
- A separate `/agent/v1/` router authenticates this role. Dashboard authentication
  must not accidentally accept scoped tokens, and agent routes must not fall
  through to the dashboard router. Reject browser origins on agent routes;
  preserve loopback binding, Host validation and bounded JSON bodies.
- Record token digests and grants in the sealed owner store. Put the scoped token
  in a workspace-local `0600` file, never in instructions, URLs, logs or Git.
  Rotate/revoke through the dashboard; workspace deletion revokes its grants.
- A local connection descriptor provides protocol version, broker address,
  workspace identity and the relative token-file location. Refresh the descriptor
  when the broker port changes. Do not print token values during setup.
- An unavailable broker leaves requests pending and instructions explain how to
  launch `repo-cloak`. Neither the HTTP client nor MCP adapter silently launches
  a privileged dashboard or auto-approves anything.

These are API permissions, not OS isolation. An agent running as the same user
with unrestricted filesystem access can potentially read the source, store key
or dashboard credentials directly. A strict confidentiality guarantee needs an
agent sandbox/container that exposes only the cloak workspace and scoped broker
connection. Instruction files are guidance; server policy enforces API access.
This feature does not itself install such an OS sandbox or claim to prevent all
existence/timing inference from arbitrary local processes.

## Paths and probe semantics

Prefer workspace-relative anonymized paths. Also accept absolute paths beneath
the registered cloak root, including paths whose final file does not exist yet.
An absolute path means `/cloaks/backend/src/NorthwindContext.cs`, never the
original source root. Use the credential's workspace binding, not an agent-
supplied source root. A container mount alias would require an owner-configured
mapping; arbitrary client-supplied aliases are not accepted in the first version.

Accept exact regular-file paths only: no directories, glob expansion, traversal,
NULs, metadata paths, external symlinks, nested repositories or arbitrary commits.
Canonicalize parents, check containment and repeat safety checks during apply.

Resolution order:

1. Use an exact existing manifest mapping when one exists.
2. Otherwise use `restorePaths` with the workspace's saved rules/ledger and
   verify that forward anonymization round-trips to the requested path. Work on
   a private ledger copy; probes must not mutate the workspace manifest.
3. If the mapping cannot be resolved uniquely, return `unavailable`. Do not
   guess replacements, reveal candidates, enumerate the source tree or perform
   fuzzy search. Unseen regex/secret replacements are not always invertible;
   the owner can select such a file manually through the existing picker.

Apply deny patterns to the normalized requested path where meaningful and the
resolved original path. A known pattern denial returns `not_allowed` regardless
of whether the named file exists. Check it before source existence/content reads.
For otherwise eligible paths, inspect bounded metadata only, verify Git ignore/
eligibility and file type, and enforce the size limit. Do not read file contents
for a probe. No source-root paths, matched patterns, sizes, replacement ledger,
raw filesystem errors or directory listings go into agent responses.

Reject known binary extensions during the metadata-only probe. Actual text/binary
classification needs bytes and therefore runs during the owner's preview, before
any file is copied. A misleading extension can make a provisional probe succeed
and still be denied during preview; `available` is never a content guarantee.

```json
{
  "results": {
    "src/NorthwindContext.cs": "available",
    "schema.graphql": "not_allowed",
    "missing.ts": "unavailable"
  }
}
```

`available` means eligible to request, not permission to read. `already_present`
is a fourth result for a local regular file the agent can already read, subject
to current policy. `unavailable` covers missing and unresolvable names without
distinguishing them. `not_allowed` gives no confirmation that a protected source
file exists and no detailed denial reason. Detailed diagnostics remain owner-only.

## Protection policy

Requests inherit the workspace's selected profiles (global or repository scoped)
and the existing repository-wide exclusions. These are the same exclusion sources
used for Pull/Push; no separate request patterns, defaults or Policy tab exist.
Unselected profiles do not impose exclusions. Read current exclusions at probe,
submission, preview and approval, including checks on resolved original paths.
Agent credentials have no include-excluded flag, and approval cannot override
an exclusion. Change the existing profile or repository settings, then review
again. Legacy request-only policy fields are ignored when reading sealed grants
and dropped on their next save.

Already shared copies cannot be made unknown again by adding an exclusion;
retain the existing exclusion behavior for those copies.

Fixed transport limits keep exact-file requests bounded:

- Maximum 1 MiB per file, 10 MiB per approved batch; text files only.
- At most 100 probe paths per call, 20 files per request, 10 pending requests per
  workspace, with a bounded probe/request rate and owner-visible queue retention.
- Bound path length, reason length (500 characters), body size and retained data.
- Deduplicate normalized/case-equivalent paths and repeated request IDs; a caller
  cannot overwrite a different payload using the same idempotency key.

These limits apply at probe, submission, preview and writer recheck; a stale probe
is never authorization. File exclusion patterns are managed only through the
existing profiles and repository settings.

## API and request lifecycle

Agent-only API (the token determines workspace; IDs cannot widen its scope):

```text
POST /agent/v1/probe          { paths: string[] }
POST /agent/v1/requests       { clientRequestId, paths: string[], reason }
GET  /agent/v1/requests/:id   sanitized per-file status for this workspace
```

Submission revalidates every path independently. Return per-file rejected states
for denied/unavailable items and queue only eligible files. Do not trust a
previous probe result or store arbitrary caller-provided original paths. Agent
status includes anonymized paths, request ID and public states only. No approval
capability or file-content download endpoint exists.

```text
eligible submission -> pending -> owner preview -> approved/running -> pulled
                         |               |                 |
                      rejected         stale             failed
```

Each file has its own state; selecting three of six pulls only those three,
leaving the rest pending unless rejected. Queue records, private resolved paths,
reasons and approval audit data live sealed under
`~/.repo-cloak/agents/<workspaceId>.json` alongside the grant and token digest.
Retain at most 50 requests, including at most 10 unfinished requests.
Use validated IDs, atomic writes, revisions and per-workspace locks. Reuse store
encryption; do not put the pending queue or private diagnostics in the cloak repo.

Owner-only routes list requests, reject selected items, create a preview and
approve/apply that preview. A group view shows queues by member workspace and
never grants one agent access to its sibling's requests. An agent tells its user
the returned request ID and asks them to approve through the dashboard; the
system does not send external messages on the agent's behalf.

## Approval and selective pull

The owner sees original and anonymized paths, bounded size/type metadata, the
agent's reason, profiles and per-file status. Treat reasons strictly as text,
not markup or instructions. Use the existing status line, compact checklists,
preview and sync operation manager; add a Requests action/badge on workspace
cards and a combined list in group view.

- Re-resolve source/workspace identity and policy on preview and again under the
  writer lock. Bind approval to the exact selected files, source hashes/modes,
  worktree/HEAD, manifest, rules, selected profile revisions, repository exclusions
  and request revision. Source reads are bounded by the file-size cap, including
  writer rechecks; disguised
  binaries are refused before copying. Selective requests preserve other
  manifest entries without reading unrelated tracked file bytes.
- Reuse explicit-file refresh planning, the saved replacement ledger and shared
  atomic writer. `planPull` already retains nonselected tracked entries. Never
  fall back to the normal refresh selection when the approved list is empty.
- Pass an exact-file selection boundary, bypassing glob/folder expansion. Assert
  that planned content writes are a subset of the approved anonymized paths;
  preserve existing agent edits, tracked selections and unrelated files.
- If current profiles differ from the workspace snapshot, stop and ask the owner
  to perform the normal profile-refresh review separately. Current pull setup
  expands changed-profile refreshes to all tracked files; request approval must
  not silently authorize that expansion.
- New path/content ledger entries must preserve old replacements, respect
  collision checks and become part of the sealed manifest so later Push restores
  newly shared files correctly. Binary files are denied on this route.
- A source, policy, mapping or workspace change after preview makes approval
  stale. Require a new preview; never pull a newly changed version implicitly.
- Repeated apply/polling after a lost response executes at most once. Serialize
  with individual/group sync and deletion. Pending requests survive restart;
  in-memory previews expire and never replay automatically.
- Record a request/operation identifier in the successful manifest pull metadata
  so a crash after file writes but before queue status save can be reconciled
  without re-pulling or falsely reporting success. Distinguish writer rollback
  from successful writes followed by an owner-store record-save error.

## Agent instructions and optional MCP

Ship a short provider-neutral instruction template and a `SKILL.md` explaining:
this is a selected, anonymized workspace; missing files may be intentional;
probe exact anonymized paths, queue only necessary files with reasons, give the
user the request ID, and wait for `pulled` before editing them. Continue with
available context after denial. Never search for the source root, print tokens,
try a different workspace or use the privileged dashboard API.

Generate workspace-local guidance on create/enable, with managed entry points
for `AGENTS.md` and `CLAUDE.md` referring to `.repo-cloak/agent/SKILL.md` and the
connection descriptor. Never replace existing user instructions or edit global
agent settings. Provider-specific skill/MCP discovery should be verified against
the relevant client's documentation when implementing the installer; a generic
Markdown file alone is not a promise of automatic skill discovery in every agent.

Track generated file/block ownership explicitly. Entirely generated files and
credential/connection files must never enter Pull selection, Push, export or
source Git. For existing source-managed instruction files, implement a managed
instruction overlay: preserve user-authored bytes, strip only the recorded
generated block before restoring/exporting, and compare/store the correct
materialized workspace baseline. Tampered/ambiguous blocks fail safely. Test
this in both directions; simply excluding every existing `AGENTS.md` would lose
legitimate source changes, while appending a block without accounting for it
would accidentally push broker guidance back into the source.

After HTTP and approval work, expose the same service through four MCP tools:

```text
cloak_probe_files(paths)
cloak_request_files(paths, reason, clientRequestId)
cloak_request_status(requestId)
cloak_workspace_info()  // anonymized identity, public limits and connection state
```

There is deliberately no approve, pull, push, raw read or source search tool.
A small `repo-cloak agent-mcp --workspace <path> --workspace-id <id>` transport
relays to the running broker. The client configuration pins the expected
workspace identity. The bridge refuses symlinked/large metadata, credentials for
another workspace, nonloopback destinations and oversized responses. This does
not restore the removed interactive CLI. HTTP usage does not depend on either
Codex or Claude configuration.

Requests -> Connection previews the command/configuration before Add to Codex or
Add to Claude Code. Codex setup appends validated TOML to this workspace's
`.codex/config.toml`, preserving existing entries and comments. Codex project
configuration requires a trusted project. Claude setup uses
`claude mcp add --scope local --transport stdio`, preserving other entries and
limiting this connection to the project. Existing server names are left unchanged.
Other clients get copyable stdio configuration. No token appears in configuration
and no client configuration changes merely because a workspace is created.

`.codex/` and `.repo-cloak/agent/` are local metadata excluded from sync. Workspace
Git ignores generated helpers and connection files. Selected original instruction
files retain their managed overlay in the cloak baseline and strip it before
restoring to source. Legacy edited instruction files must be pushed before
installing guidance so their baseline cannot silently change.

Setup references: [Codex MCP](https://developers.openai.com/codex/mcp/),
[Claude Code MCP](https://code.claude.com/docs/en/mcp). The official MCP SDK handles
stdio framing/initialization; smol-toml validates configuration before appending.
These are the two new runtime dependencies. Browser assets are capped at 92 KB
(previously 82 KB for groups).

## Implementation sequence and acceptance

1. **Policy and path resolution.** Pure types, schemas, scoped public outcomes,
   round-trip resolution and exact-file policy. Test literal variants, unknown
   regex mappings, collisions, protected-but-missing names, traversal, symlinks,
   binaries, size limits and nonmutation of the saved ledger.
2. **Credentials and queue.** Sealed grants/requests, revocation, safe agent
   router, idempotency, quotas and sanitized diagnostics. Test foreign workspace
   IDs, agent access to every privileged route, raw-error leaks and restart.
3. **Dashboard approval.** Per-file review/rejection, exact selective pull and
   group aggregation. Test denied files never read/copied, approval subset only,
   saved profiles and existing edits preserved, stale approvals, source policy
   changes, concurrency, crash reconciliation and later Push restoration.
4. **Workspace instructions.** Generate safe guidance and managed overlays for
   new and existing workspaces. Test user instructions preserved, generated data
   absent from source/export/Git, and correct pull/push hash baselines.
5. **MCP adapter and client setup.** Reuse the broker service, document HTTP and
   MCP setup, verify both agent clients, and test transport tools have exactly
   the scoped capabilities. No approval tool is registered.
6. **End-to-end validation.** An agent requests six files, some are denied, the
   owner approves a subset, only those files appear anonymized, status survives
   reload/restart, and Push restores edits. Check desktop/mobile, both themes,
   required code checks and the package asset budget before marking complete.

Keep new pure policy/state logic in `core/agent-requests.ts`; put path/filesystem
resolution, sealed persistence and credentials in focused adapters; orchestrate
through `application/agent-requests.ts` and an owner approval service that reuses
the current sync engine. Route agent auth separately from owner dashboard auth.
No code from `archive/` or hand-edited generated wiki content is needed.
