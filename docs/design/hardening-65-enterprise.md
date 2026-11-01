# Hardening 65: enterprise review fixes

## Problem

A security review reproduced two weaknesses. An agent that could write to a workspace's `.git`
could get repo-cloak to run commands outside the agent's sandbox. Secret detectors missed common
formats and are opt-in. Audit exports were signed with a throwaway key, which proved nothing.

## Design

### Workspace Git

```
runGit(cwd) --> has .repo-cloak/? --no--> git
                     | yes
                     v
      git config --file .git/config --name-only --list   (runs nothing, follows no include)
                     |
      unsafeGitConfigKeys() --any--> refuse, naming the keys
                     | none
                     v
                    git
```

The allowlist is in `core/git-config.ts`: anything not named is refused. `.git` must be a real
directory. Workspace commits set `core.hooksPath` to the null device, not a folder in `.git` that
an agent could also write to, and `core.fsmonitor=false`.

### Secrets

New detectors join the catalog, opt-in like the others, so existing profiles produce the same
output. The leftover scan also runs every detector over the cloaked text and warns with kind
`secret`, naming the detector and never the value. It stays a warning and blocks nothing.

### Audit export

```
audit/signing-key.json  { sealed: <Ed25519 PKCS8 PEM> }   AAD { kind: 'audit-signing-key' }
export                  { jsonl, signature, publicKey, fingerprint }
```

Created on first export and resealed with the log on key rotation. A damaged key fails the export
rather than being replaced, because a new key would be a new identity.

## Decisions

- Allowlist over denylist: Git keeps adding keys that run commands.
- Refuse over strip: editing a user's config silently could break something they meant to set.
- Warn about unmatched secrets over always replacing them: replacing would change the output and
  ledgers of existing workspaces.
- The signing key lives on the same machine. Compare the fingerprint out of band and keep earlier
  exports: a later export whose chain does not extend an earlier one shows a rollback.

## Open questions

- Forwarding audit events off the machine, which would make rollback detectable without exports.
- Whether an organisation policy should turn on secret rules or block a pull on a `secret` warning.
