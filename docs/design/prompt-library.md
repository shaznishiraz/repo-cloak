# Prompt library and repository packages

Status: **proposed**, pending design approval. Implements requirement R10.

## Experience

Add a compact **Prompts** section beside Profiles. A prompt has a title, Markdown
body and optional tags such as `backend`, `frontend` and `.net`. Packages are
named, ordered collections of saved prompts. Users can search titles/body and
filter by tag, edit prompts, organize packages and assign either prompts or
packages to registered repositories.

```
Prompts                           [Prompts | Packages] [+ New]
------------------------------------------------------------
Search...  [All tags v]       | Title
[ ] Backend conventions      | Tags       backend  .net
    backend  .net     [Edit]  | Markdown instructions...
[ ] Review checklist  [Edit] |
                             | [Save]                [Delete]

Repository assignments
[Source repository v]       Packages [Backend essentials v]
                             Prompts  [Review checklist v]
                                      [Save assignments]
```

Workspace creation inherits the repository's assignments. Its existing review
step shows the resolved prompts, their anonymized content, and an optional
selection control; no extra mandatory wizard step. An explicit empty selection
creates a workspace without prompts. Tags help find prompts; they do not silently
assign prompts to repositories.

## Identity and lifecycle

```
main checkout ----+
linked worktree --+--> realpath(git --git-common-dir)
linked worktree --+               |
                            existing repoId
                                 |
                    saved prompt/package assignments
                                 |
                   resolve + deduplicate + anonymize
                                 |
                       creation preview + approval
                                 |
                   cloak workspace instruction snapshot
```

Reuse `resolveRepo` and `repoId`; never key by branch name, worktree folder name
or the currently selected checkout path. Tests already establish shared identity
for linked worktrees and nested/symlink paths. Independent clones remain separate
repositories, consistent with current identity behavior.

New workspaces inherit the latest assignments. Each created workspace records the
exact selected versions. Editing the library or changing repository assignments
affects future creations; it does not silently rewrite existing cloaks. Regular
Pull/Push preserves each workspace's prompt snapshot. Explicitly updating prompts
in existing workspaces is a later feature, not an automatic side effect of Pull.
Moving a cloak into a group preserves its snapshot. Group-root instructions
continue to direct agents to the individual member instructions, keeping backend
and frontend prompts in their own scopes.

## Data and storage

Use one new sealed document kind, `prompt-library`, stored at
`~/.repo-cloak/prompts/library.json`, through the existing AES-256-GCM store/key
and private-file permissions. Titles, bodies, tags, package membership and
repository assignments are all inside the encrypted envelope. Do not use browser
localStorage for prompt content. This uses the existing local key-file model;
it does not introduce an OS keychain integration.

```ts
type Prompt = {
  id: string; // generated stable identifier, never a user-selected file path
  title: string;
  body: string;
  tags: string[];
};
type PromptPackage = { id: string; name: string; promptIds: string[] };
type PromptSelection = { promptIds: string[]; packageIds: string[] };
type PromptLibrary = {
  kind: 'prompt-library';
  schemaVersion: 1;
  prompts: Prompt[];
  packages: PromptPackage[];
  assignments: Record<string, PromptSelection>; // existing repoId keys
};
type WorkspacePrompts = {
  selection: PromptSelection;
  prompts: { id: string; hash: string; title: string; body: string }[];
  generatedHash: string;
};
```

Validate references, registered repository identities and explicit size limits:
titles up to 120 characters, up to 20 tags of 32 characters, prompt bodies up to
64 KiB, and a selected bundle up to 512 KiB. Normalize/deduplicate tags without
restricting users to a fixed vocabulary. Resolve package order first, then direct
prompts, deduplicating stable IDs at first occurrence. Package order is editable
with small Move up/Move down controls.

Serialize writes under a library lock and require a revision/hash for updates;
concurrent edits return a conflict instead of overwriting. Block deleting prompts
or packages still referenced by packages or repository assignments and show where
they are used. Existing workspace snapshots remain valid after library changes.

## Injection and sync boundaries

- Use the selected anonymization profiles and secret detectors for prompt titles
  and bodies before preview/injection. Do not interpolate real source paths.
- Render one neutral, fixed-path Markdown file:
  `.repo-cloak/prompts/INSTRUCTIONS.md`. Only the selected anonymized text enters
  the cloak. The library and its original text remain in the owner store.
- Include a small managed pointer in `AGENTS.md` and `CLAUDE.md`, preserving user
  instructions and existing file-request guidance. Preserve compatibility with
  the exact legacy guidance suffix: version-aware add/strip logic must prevent
  prompt pointers or prompt content from being pushed into source instructions.
- Store exact bundle metadata in the sealed manifest payload. Generated prompts
  are local helpers, absent from source selection, source Push, export and cloak
  Git checkpoints, following the existing helper policy. They are readable by
  the agent in the cloak, as intended.
- Protect helper paths from source collisions and symlink traversal. Never
  overwrite unrelated files. Keep generated content stable on regular Pull;
  edited managed instructions must fail safely rather than leaking on Push.
- Bind creation approval to selection, prompt/package content and assignments,
  alongside the existing profile/source/destination checks. A relevant library
  edit after preview invalidates approval. No prompt writes occur before apply.
- Include helper writes and manifest changes in the existing workspace writer
  transaction; on failure, restore files, Git index and registration together.

## Implementation boundaries

- `core/prompts.ts`: schemas, validation, deterministic selection and rendering.
- `adapters/prompts.ts`: sealed library storage, locking and revisions.
- `application/dashboard-prompts.ts`: owner CRUD, assignment and selection APIs.
- Extend shared pull preparation/planning and managed-guidance handling for
  previewed creation snapshots; keep prompt helpers out of restoration/status.
- Owner-token protected `/api/prompts/...` routes. Scoped agent MCP/HTTP tools
  cannot read or edit the owner's library or assignments.
- Reuse the vanilla UI, existing icon system and compact management layout.
  Measure shipped assets and keep a documented, enforced package budget; add no
  runtime dependency for this feature.

## Acceptance scenarios

1. Create, edit, tag, search and delete an unreferenced prompt; organize and
   reorder packages. A restart preserves the encrypted library and assignments.
2. Assign a package and direct prompt to a repository; main and linked/nested
   worktrees inherit the same selection, while an unrelated repository does not.
3. Preview creation with inherited, overridden and empty selections. No files
   are written before approval; selected prompt content is anonymized exactly.
4. Reject stale previews after selected prompt, package, assignment or profile
   changes; detect concurrent library edits without lost updates.
5. Create both instruction files safely, preserve selected source instructions,
   and roll back all new helper writes when creation/checkpointing fails.
6. Pull/Push, export, status, agent-request pulls and grouping retain snapshots
   without copying generated prompts into source or exposing owner-library data.
7. Reject invalid references, excessive bodies/bundles, unsafe helper paths,
   missing owner authentication and attempts through scoped agent credentials.
8. Required typecheck/lint/tests and build/package checks pass. Add browser
   coverage for management and creation at desktop/390px in both themes; record
   any unavailable live-browser validation explicitly.
