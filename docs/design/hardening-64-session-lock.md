# Hardening 64: real session lock and one folder picker

Builds on [web-ui.md](web-ui.md#session-and-security). This changes what `ui.lock` holds
and how a second launch reaches a running server.

## Session model

```
 ui.lock (0600)                    server process (memory only)
 +------------------+              +----------------------------------+
 | port             |              | SessionGate                      |
 | pid              |              |   tokenHashes: sha256[]          |
 | launcherKey ------------------> |   launcherKeyHash: sha256        |
 +------------------+   proves     |   lastActivity, idle limit       |
   no browser token     same user  +----------------------------------+
                                     ^           ^             ^
 repo-cloak (again)                  |           |             |
   POST /launcher/v1/session --------+           |             |
     Bearer launcherKey, no Origin               |             |
     <- { app, protocol: 2, pid, token }         |             |
   opens /#token=<fresh>                         |             |
                                                 |             |
 browser tab                                     |             |
   every /api/* call, Bearer token --------------+             |
   POST /api/v2/session/activity (input only, throttled) ------+
   POST /api/v2/session/lock    -> revokes every token
   401 from anything            -> lock screen
   BroadcastChannel 'cloak-session': lock | activity

 agent client
   /agent/v1/*, own scoped credential; answered before the gate, unaffected by it
```

## Key types

```ts
// src/adapters/session-gate.ts
type SessionGate = {
  authorize(header: string | undefined): Promise<boolean>; // sweep, then compare
  launch(header: string | undefined): Promise<string | null>; // fresh token, or null
  activity(): void; // user input only
  revoke(): void; // every token, for good
};

// contracts.ts
'POST /api/v2/session/lock': R<{ locked: true }>;
'POST /api/v2/session/activity': R<{ ok: true }>;
```

## Rules

- **Comparison.** Credentials are compared as SHA-256 digests with `timingSafeEqual`, against
  every live token with no early exit. Only digests stay in memory. The launcher key and
  browser tokens are separate sets: neither works in the other's place.
- **Revocation is forever.** A token enters the set once, from fresh random bytes (or the
  value given at server creation), and is never re-added. Nothing is persisted, so a restart
  cannot restore one either.
- **Tokens coexist.** A relaunch adds a token and leaves other tabs signed in. Lock and idle
  expiry revoke them all. A relaunch never rescues expired tokens: `launch` sweeps first.
- **Idle clock.** One clock per server. Only `POST /session/activity` and a launch move it.
  Polling, other API calls and agent calls do not, so a forgotten open tab still expires.
  The sweep runs before each authorized request and each launch. It is lazy, so a closed tab
  needs no timer: the next request finds the token expired.
- **Limit.** `dashboard.settings.effective().autoLockMinutes`, reread on each authorized
  request, so policy and Settings changes apply at once. `null` means no expiry, and holds the
  clock at now so that turning the limit on does not instantly expire a long-idle session.
- **Tab idle timer.** Stays as a safety net for a server that has gone away. It shares input
  between tabs over `BroadcastChannel`, because firing revokes every tab and must not lock a
  tab in active use because a hidden one sat idle. A new tab counts as input for this purpose.
- **Lock order in a tab.** Show the lock screen and clear sessionStorage first, then post the
  revoke (waiting at most 2 s), then tell other tabs, then reload to clear memory.
- **Unlock.** Run `repo-cloak` in a terminal. It opens a new tab with a fresh fragment token.
  There is no unlock form, no token in any other URL, and locked tabs stay locked. A launch
  link pasted into an open tab reloads it, so that tab reads the token and the address clears.
- **Launcher route.** Outside `/api`, POST only. Any `Origin` header gets 403, as agent routes
  do, so a page cannot use it. Bearer auth with the key from `ui.lock`. It replaces
  `GET /api/session`, which is removed. Protocol becomes 2.

## Sync during a lock

Operations run in the server, on `dashboard.sync.operations`, and are not tied to a token. A
lock does not call `dashboard.sync.close()`, which stays on server close.

```
 apply -> running ------------------------> completed | failed
              |  lock or idle expiry            |
              v                                 v
       tab: lock screen                 relaunch: fresh token reads the state
```

A request that passed the gate before the lock runs to its end. A request after it gets 401
and starts nothing. A pending preview stays until its normal expiry and needs a live token to
apply.

## Failure behaviour

| Case                                               | Result                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| Lock POST fails or takes over 2 s                  | Tab still locks; token dies at idle expiry or server exit         |
| Limit unset and lock POST fails                    | Token stays valid until server exit; tab has forgotten it         |
| Settings or policy unreadable                      | Last known limit stays in force                                   |
| Limit raised before any request                    | Not-yet-swept session survives under the new limit                |
| Hidden tab                                         | No polling; channel locks it, else the refresh on show gets a 401 |
| `BroadcastChannel` missing                         | Each tab locks at its next 401                                    |
| Bad or missing launcher key                        | 401, no token issued                                              |
| `ui.lock` from an older running version            | Fails schema; launch reports the dashboard is busy until stopped  |
| Launcher times out after the server issued a token | Orphan token, unknown to anyone, dies with the next lock          |
| System clock moved back                            | Idle period lengthens by that amount                              |

## Folder picker

```
 src/web/shell/folder-picker.tsx   (imports shell only)
   FolderPicker inline             FolderPicker (dialog)
     Settings, Known repos           Setup, New cloak
     parent has the path field       has its own "Folder path" field
         \                             /
          shared: load, stale-answer guard, "Folders" list, More folders,
          alert: "Could not list folders: ... Type the path instead."
```

`parentFolder` moves with it. Picker CSS leaves `new.css` and `admin.css`.
