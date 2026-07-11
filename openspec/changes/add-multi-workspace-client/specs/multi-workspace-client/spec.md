# multi-workspace-client — spec delta

## ADDED Requirements

### Requirement: Daemons registry file

The terminal client SHALL maintain a TOML file at
`~/.qwen/rc/clients.toml` (file mode `0600`) listing known
daemons:

```toml
[[daemon]]
name = "workstation-1"
url  = "https://qwen.local:4170"
tokenStorageKey = "qwen-rc:qwen.local:4170:token"
default = true

[[daemon]]
name = "side-project"
url  = "https://qwen.local:4171"
tokenStorageKey = "qwen-rc:qwen.local:4171:token"
```

Each entry MUST have a unique `name` and a unique `url`. Exactly
one entry MAY have `default = true`; if none do, the first entry
is treated as default. Writes SHALL be atomic (temp file + rename)
so a crash mid-write does not corrupt the file.

#### Scenario: First-time creation

- **GIVEN** `~/.qwen/rc/clients.toml` does not exist
- **WHEN** the CLI is invoked
- **THEN** the file is NOT auto-created with empty content
- **AND** the CLI prints a hint to run `qwen rc daemons add`

#### Scenario: Duplicate URL rejected

- **GIVEN** registry already contains a daemon with URL `U`
- **WHEN** `qwen rc daemons add <name2> U` is run
- **THEN** the command fails with exit code 1 and message
  `daemon_url_duplicate`
- **AND** the TOML is unchanged

#### Scenario: Atomic write under crash

- **GIVEN** a write to the TOML is in flight
- **WHEN** the process is killed
- **THEN** the file either reflects the prior state or the new
  state, never a half-written intermediate

### Requirement: Token storage

Tokens for each daemon SHALL be stored under the
`tokenStorageKey` namespace. The terminal client SHALL use the OS
keyring where available (macOS Keychain, Linux Secret Service,
Windows Credential Manager). When the keyring is unavailable, the
client SHALL fall back to a mode-0600 file at
`~/.qwen/rc/tokens/<sanitised>.tok` and SHALL emit a one-time
stderr warning per invocation.

The web client SHALL store the same token under
`localStorage[<tokenStorageKey>]` in the daemon's own origin.

#### Scenario: Keyring fallback warns once

- **GIVEN** no OS keyring is available
- **WHEN** the CLI runs `qwen rc daemons add` and stores a token
- **THEN** the token is written to
  `~/.qwen/rc/tokens/<sanitised>.tok` with mode `0600`
- **AND** stderr includes the warning
  `os_keyring_unavailable_using_file_fallback`

### Requirement: Registry CLI

The CLI SHALL expose `qwen rc daemons` with subcommands:

- `list` — print a table: `name`, `url`, default flag, last-known
  health, token presence (`present` / `missing`).
- `add <name> <url>` — interactive flow:
  1. `GET <url>/capabilities`; reject if unreachable or not a
     remote-control daemon.
  2. Display a trust warning: "This daemon can serve arbitrary
     JavaScript to your browser when you open its UI. Continue?"
     Default no.
  3. On confirm, walk the pairing flow (prompt user to paste a
     pairing code minted on the daemon's host).
  4. Persist the registry entry and the token atomically.
- `remove <name>` — best-effort `DELETE /rc/tokens/<tokenId>` on
  the daemon, then delete from registry and keyring.
- `set-default <name>` — flip the default flag.
- `health [--all]` — `GET /health` against each daemon; print
  result.
- `whoami [--daemon <name>]` — print token name, scope, expiry as
  reported by `/rc/tokens/whoami` (or equivalent owner lookup).

#### Scenario: Add rejects non-daemon URL

- **GIVEN** a URL that returns 404 on `/capabilities`
- **WHEN** the operator runs `qwen rc daemons add foo <url>`
- **THEN** the command fails with code `not_a_qwen_daemon`
- **AND** the registry is unchanged

#### Scenario: Add prompts trust confirmation

- **GIVEN** the URL is a valid daemon
- **WHEN** the operator runs `qwen rc daemons add`
- **THEN** the CLI prints the trust warning before any pairing
- **AND** declining the warning exits without writing anything

#### Scenario: Remove revokes token on daemon

- **GIVEN** a registered daemon with a working token
- **WHEN** the operator runs `qwen rc daemons remove <name>`
- **THEN** the CLI POSTs `DELETE /rc/tokens/<tokenId>` to the
  daemon
- **AND** removes the keyring entry
- **AND** removes the TOML entry

### Requirement: `--daemon` flag on per-daemon commands

Every per-daemon CLI command SHALL accept `--daemon <name>` and
SHALL default to the registry's default daemon when omitted. The
following commands MUST support the flag:

- `qwen rc attach`, `qwen rc pair`, `qwen rc tokens`,
  `qwen rc audit`, `qwen rc share`, `qwen rc search`,
  `qwen rc sessions`, `qwen rc bridges`, `qwen rc fork`.

If the named daemon does not exist in the registry, the command
SHALL exit code 1 with `daemon_unknown`.

If the registry is empty, any per-daemon command SHALL exit with
`registry_empty` and a hint to run `qwen rc daemons add`.

#### Scenario: Explicit daemon selection

- **GIVEN** registry has daemons `A` (default) and `B`
- **WHEN** the operator runs `qwen rc attach --daemon B`
- **THEN** the command connects to daemon `B`'s URL

#### Scenario: Default fallback

- **GIVEN** registry has daemons `A` (default) and `B`
- **WHEN** the operator runs `qwen rc attach`
- **THEN** the command connects to daemon `A`

### Requirement: Manifest endpoint on daemons

Each daemon SHALL expose `GET /ui/clients-manifest.json`
(owner-scope required) which returns the parsed contents of
`~/.qwen/rc/clients.toml` as JSON:

```jsonc
{
  "daemons": [
    {
      "name": "workstation-1",
      "url": "https://qwen.local:4170",
      "tokenStorageKey": "qwen-rc:qwen.local:4170:token",
      "default": true,
    },
  ],
  "generatedAt": "<ISO>",
}
```

The response SHALL be cached server-side for 60 s. If the TOML is
missing or invalid, the response SHALL be `{ "daemons": [],
"warning": "<reason>" }` with status 200.

#### Scenario: Owner fetches manifest

- **GIVEN** an owner-scope token on daemon `A`
- **WHEN** the client requests `/ui/clients-manifest.json`
- **THEN** the response is the parsed TOML as JSON
- **AND** is identical across daemons that share the same
  operator home directory

#### Scenario: Non-owner cannot fetch

- **GIVEN** a `read`-scope token
- **WHEN** the client requests `/ui/clients-manifest.json`
- **THEN** the response is `403 Forbidden`

### Requirement: Daemon switcher and health polling

The web client SHALL render a header dropdown listing each
configured daemon with a coloured health indicator:

- Green dot: `GET <daemon>/health` returned 200 within the last
  30 s.
- Yellow dot: last successful 200 is between 30 s and 5 min old,
  OR latest poll returned a non-OK 5xx.
- Red dot: latest poll returned `401`, `403`, network failure, or
  no success in over 5 min.

The web client SHALL poll each daemon's `/health` every 30 s
(configurable, min 10 s). Polling SHALL pause when the tab is
backgrounded (`document.visibilityState !== "visible"`) and
resume on tab return.

Switching to a daemon SHALL invoke `location.assign(<daemon>/ui/)`
(a full navigation), not an in-tab data swap.

#### Scenario: Healthy daemon is green

- **GIVEN** daemon `A` returns 200 on `/health`
- **WHEN** the switcher next polls
- **THEN** `A`'s dot is green

#### Scenario: Unreachable daemon is red

- **GIVEN** daemon `B` is offline (network error)
- **WHEN** the switcher polls
- **THEN** `B`'s dot is red within one poll cycle
- **AND** clicking `B` still attempts navigation; the resulting
  load surface shows an error page

#### Scenario: Polling pauses while tab is backgrounded

- **GIVEN** the switcher is polling once per 30 s
- **WHEN** the user backgrounds the tab for 5 minutes
- **THEN** no health requests are sent during that period
- **AND** polling resumes on visibility return

### Requirement: Aggregated sessions view

The web client SHALL provide `/ui/sessions` which fans out
`GET /workspace/<cwd>/sessions` to every configured daemon (using
each daemon's token from local storage). The view SHALL render a
unified list with daemon-name pills, and SHALL render
"UNREACHABLE — last seen <relative>" for daemons whose fetch
failed.

Clicking a session SHALL navigate to that daemon's
`/ui/session/<sid>`.

#### Scenario: All daemons respond

- **GIVEN** daemons `A`, `B`, `C` all online with 2 sessions each
- **WHEN** the operator loads `/ui/sessions`
- **THEN** six rows render, each tagged with its source daemon
  name
- **AND** rows are sorted by `lastActivityAt` desc across daemons

#### Scenario: One daemon down

- **GIVEN** daemon `B` is unreachable
- **WHEN** the operator loads `/ui/sessions`
- **THEN** rows for `A` and `C` render normally
- **AND** a single row reads "B: UNREACHABLE — last seen 4m ago"

### Requirement: Aggregated cross-daemon search

The search modal SHALL include an "Across all daemons" toggle.
When enabled, the client SHALL:

1. Fan out the same `GET /rc/search?q=…` to each configured
   daemon in parallel.
2. Tag each hit with `daemonName`.
3. Merge results client-side by round-robin top-`min(limit/N,
10)` from each daemon, then sort within tie-bands by score.
4. Render each result row with the `daemonName` as a pill.

Daemons that fail or return non-2xx SHALL be listed in a footer
note ("`B`: 401 not paired · re-pair to include"). Their absence
MUST NOT cause the modal to fail.

Each daemon SHALL apply its own scope filter to its own results
(per `add-cross-session-search` `Requirement: Permission
filtering`). The aggregator MUST NOT perform any cross-daemon
ACL traversal.

#### Scenario: Three daemons, one with hits

- **GIVEN** daemons `A`, `B`, `C` configured; only `A` indexed
  the matched phrase
- **WHEN** the operator searches `q="oauth refresh"` with the
  toggle on
- **THEN** all hits come from `A`, each tagged `[workstation-1]`
- **AND** the footer notes `B: 0 hits · C: 0 hits`

#### Scenario: Auth-failed daemon excluded from merge

- **GIVEN** daemon `B`'s token has expired
- **WHEN** the operator runs an aggregated search
- **THEN** the modal renders results from `A` and `C` only
- **AND** the footer reads `B: 401 not paired · re-pair to
include`

#### Scenario: Aggregator does not leak across daemons

- **GIVEN** daemon `A` has a session `S_a` not visible to the
  caller, and daemon `B` has a session `S_b` not visible to the
  caller
- **WHEN** the operator searches across all daemons
- **THEN** the merged results contain no hits from `S_a` or `S_b`
- **AND** the daemons' own permission filters performed the
  exclusion server-side; the client never received the rows

### Requirement: Per-daemon push subscription

The web client SHALL maintain a separate webpush subscription per
configured daemon. Adding a daemon SHALL subscribe; removing SHALL
unsubscribe; detecting a revoked token SHALL unsubscribe and
prompt re-pair. Service-worker delivered notifications SHALL
include the daemon name in the title (e.g.,
`[workstation-1] Permission requested in oauth-debug`).

#### Scenario: Removing a daemon ends its push

- **GIVEN** a registered daemon `B` with an active webpush
  subscription
- **WHEN** the operator runs `qwen rc daemons remove B`
- **THEN** the web client unsubscribes from `B`'s push (on next
  load)
- **AND** no further `B`-originated notifications arrive

#### Scenario: Notification displays source daemon

- **GIVEN** daemon `A` emits a push for a permission request
- **WHEN** the service worker delivers the OS notification
- **THEN** the title begins with `[workstation-1]` (or whichever
  daemon name `A` corresponds to)

### Requirement: Trust step on adding a daemon

Both CLI and web-client "add daemon" flows SHALL require an
explicit user confirmation that includes the text "can serve
arbitrary JavaScript to your browser when you open its UI."
Declining the confirmation MUST result in no registry change and
no pairing attempt.

The web client flow SHALL additionally require that the user has
typed or pasted the daemon's full URL — there is no auto-detect,
no link-driven add, no "discovered nearby daemon" flow in this
change.

#### Scenario: Confirmation declined

- **GIVEN** an operator runs `qwen rc daemons add` and reaches
  the trust confirmation prompt
- **WHEN** the operator answers `no`
- **THEN** the registry is unchanged
- **AND** no pairing code is requested from the daemon

#### Scenario: Web-client add requires explicit URL

- **GIVEN** the operator opens the web client's "Add a daemon"
  modal
- **WHEN** they attempt to submit with an empty URL field
- **THEN** the form is rejected with a "URL required" inline
  error
- **AND** no automatic suggestions are presented

### Requirement: Origin isolation between daemons

Tokens for daemon `B` SHALL be inaccessible from daemon `A`'s
served JavaScript. This is achieved by storing each token under
`localStorage[<tokenStorageKey>]` in the daemon's own origin; the
browser's same-origin policy enforces isolation.

The daemon's CORS allowlist (from `add-remote-control` Phase 2.5)
MUST include the origins of any other daemon whose web client is
expected to perform aggregated reads. Pairing with a daemon's web
client from daemon `B`'s UI SHALL automatically add `B`'s origin
to the paired daemon's CORS allowlist (since the existing pairing
flow records the `Origin` header at redemption time).

#### Scenario: Cross-origin token read is blocked

- **GIVEN** daemon `A` is served at origin `https://qwen.local:4170`
  and stores its token at `localStorage[qwen-rc:qwen.local:4170:token]`
- **WHEN** daemon `B`'s JavaScript (origin `https://qwen.local:4171`)
  attempts to read `localStorage[qwen-rc:qwen.local:4170:token]`
- **THEN** the browser returns `undefined` (different origin)
- **AND** `A`'s token is not exposed
