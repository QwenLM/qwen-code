# Design — add-multi-workspace-client

## Context

`add-remote-control` D6 preserves the rule **one daemon = one
workspace = one human owner**. The reasoning is sound: pairing,
audit, scopes, CORS, sessions, search are all unambiguously
scoped. The cost is that operators with many projects run many
daemons. Without aggregation, each daemon is a separate browser
URL, a separate paired token, a separate session list.

This change addresses the cost without touching the daemon. It
introduces a **client-side** registry of daemons, a switcher UI,
aggregated landing pages, and aggregated search (which fans out
to each daemon's per-daemon `/rc/search` endpoint introduced in
`add-cross-session-search`).

The trust model is explicit and conservative: adding a daemon is
not idle. The web client served by daemon A runs in origin A's
security context; visiting daemon A's `/ui` while a different
daemon B is configured does NOT give daemon A any reach into
daemon B. Per-daemon tokens are stored under per-origin
`localStorage` keys; a malicious daemon cannot read them.

The CLI experience mirrors the web client: every per-daemon
operation accepts `--daemon <name>` or defaults to the configured
default daemon.

## Goals / Non-Goals

**Goals:**

- A registry of daemons that the operator manages with a small
  CLI.
- A web client switcher that scopes the active UI to one daemon.
- An aggregated sessions view that fans out reads to all
  configured daemons.
- Aggregated search across daemons, with per-result daemon
  attribution.
- Health polling per daemon.
- Per-daemon push subscriptions (notifications carry daemon
  name).
- Strict per-origin token isolation; daemon A cannot read daemon
  B's token from the browser.
- No daemon-side changes required.

**Non-Goals:**

- Multi-workspace daemons (preserves D6).
- Session migration between daemons.
- Cross-daemon agent state sharing.
- A cloud-hosted registry of daemons.
- Discovery (mDNS, Bonjour, DNS-SD).
- A "logged into all daemons" SSO illusion. Pairing is per-
  daemon.
- Federated audit / search index.
- Server-side fan-out (a "meta-daemon" that proxies to others).
- Cross-daemon ACLs (sharing a session from A to B).

## Architecture

```
   Operator's machine
   ──────────────────
   ~/.qwen/rc/clients.toml              (terminal-client config)
   ┌──────────────────────────────┐
   │ [[daemon]]                   │
   │ name = "workstation-1"       │
   │ url  = "https://qwen.../"    │
   │ tokenStorageKey = "qwen-rc:" │
   │ default = true               │
   │ ...                          │
   └──────────────────────────────┘

   Terminal client `qwen rc`
   ┌──────────────────────────────┐
   │ - reads clients.toml         │
   │ - per-cmd `--daemon <name>`  │
   │ - default fallback           │
   │ - HTTP+SSE to one daemon at  │
   │   a time per command         │
   └──────────────────────────────┘

   Browser
   ──────
   ┌──────────────────────────────────────────────────────────┐
   │ Tab on https://daemon-A/ui  (origin A)                   │
   │   localStorage[qwen-rc:A:token]                          │
   │   localStorage[qwen-rc:clients] = JSON registry          │
   │   (synced from clients.toml on first load by /ui/        │
   │    clients-manifest.json owner-only fetch)               │
   │                                                          │
   │   Daemon switcher dropdown lists A, B, C with health     │
   │   dots polled every 30 s (no-token GET /health).         │
   │                                                          │
   │   Switching from A → B opens https://daemon-B/ui in the  │
   │   same tab (full navigation, NOT cross-origin XHR).      │
   │   New origin loads its own web client, reads its own     │
   │   token from its own localStorage key.                   │
   │                                                          │
   │   Aggregated views (/ui/sessions, search "all daemons")  │
   │   issue cross-origin fetches to each daemon's API, each  │
   │   with its own Bearer token from local storage. CORS     │
   │   on every daemon must allow the active origin (handled  │
   │   by pairing-derived CORS allowlist from                 │
   │   add-remote-control Phase 2.5).                         │
   └──────────────────────────────────────────────────────────┘
```

The architecture's key constraint: the **client's origin matters**.
A web client served from daemon A makes cross-origin fetches to
daemon B's API. For this to work, daemon B must include daemon A's
origin in its CORS allowlist. The pairing flow from
`add-remote-control` already records origins; pairing daemon B from
daemon A's web client populates daemon B's CORS allowlist
correctly.

The simpler alternative — having one daemon "host the aggregator"
and proxy to others — is rejected because it inverts the trust
model: now daemon A holds tokens for daemons B and C; a compromise
of A reveals everything.

## clients.toml

```toml
# Terminal-client config. Persisted, edited by `qwen rc daemons` or
# by hand. Tokens are NOT stored here; tokens live in the OS keyring
# (macOS Keychain, Linux Secret Service, Windows Credential Manager)
# under a key derived from `tokenStorageKey`.

[[daemon]]
name = "workstation-1"
url  = "https://qwen.local:4170"
tokenStorageKey = "qwen-rc:qwen.local:4170:token"
default = true

[[daemon]]
name = "side-project"
url  = "https://qwen.local:4171"
tokenStorageKey = "qwen-rc:qwen.local:4171:token"

[[daemon]]
name = "laptop-tunnel"
url  = "https://qwen.example.org"
tokenStorageKey = "qwen-rc:qwen.example.org:token"
```

`tokenStorageKey` is also the localStorage key the web client uses,
so the same key namespacing is shared. The actual token in the
terminal client goes into the OS keyring; the web client puts the
same value under `localStorage[<tokenStorageKey>]` (in the daemon's
own origin, which is a coincidence of how the key is computed:
`qwen-rc:<host:port>:token`).

Only one daemon may have `default = true`. The CLI validates this
on every write.

## Web client structure

```
   /ui/                  (chat/transcript UI for the active daemon)
   /ui/sessions          (aggregated landing across all daemons)
   /ui/daemons           (registry view; add/remove daemons)
   /ui/share/<token>     (bootstrap from add-link-share — unchanged)
   /ui/clients-manifest.json
                         (owner-fetched: returns the parsed
                          clients.toml as JSON, so the web client
                          knows what other daemons exist; this
                          endpoint is daemon-implemented in
                          this change as a small read of
                          clients.toml)
```

`/ui/clients-manifest.json` is a per-daemon endpoint that returns
the operator's known-daemons list parsed from `clients.toml`.
Owner scope required. Each daemon serves the same view (they share
the same TOML, which lives in the operator's home directory and
each daemon process reads it). The web client caches the manifest
for 5 minutes and refreshes on user action.

### Switcher UX

The header dropdown is a stateless dropdown:

```
   ┌──────────────────────────────┐
   │ workstation-1 (current)  ●   │
   │ side-project           ●     │
   │ laptop-tunnel          ●     │
   │ ─────────────────────────    │
   │ Manage daemons…              │
   │ Add a daemon…                │
   └──────────────────────────────┘
```

Dot colour: green = `/health` returned 200 in last 30 s; yellow =
last `/health` was older than 30 s but newer than 5 min OR returned
non-OK 5xx; red = `/health` failed (network or 401/403/404).
Switching to a daemon does a top-level `location.assign(daemon.url

- "/ui/")` — a real navigation, not an in-tab swap — because the
  new daemon's UI must run in its own origin.

### Aggregated sessions view

```
   /ui/sessions

   ┌────────────────────────────────────────────────────────────┐
   │ All sessions across 3 daemons                              │
   │                                                            │
   │ ◉ workstation-1  · oauth-debug      active     2h   open ▸ │
   │ ◉ workstation-1  · refactor-api     idle       1d   open ▸ │
   │ ◉ side-project   · scaffold-app     active    14m   open ▸ │
   │ ◯ laptop-tunnel  · UNREACHABLE — last seen 5m ago          │
   └────────────────────────────────────────────────────────────┘
```

The view fans out `GET /workspace/<cwd>/sessions` to each daemon
with the daemon's token. Failures don't block the view; the row
displays "UNREACHABLE" with the last successful poll time. "Open"
buttons navigate to the daemon's own `/ui/session/<sid>`.

### Aggregated search

The search modal from `add-cross-session-search` gains an "across
all daemons" toggle. When on, the client:

1. Fans out the same `GET /rc/search?q=…` to each daemon.
2. Tags each result with the source daemon name.
3. Merges results, sorted by per-daemon BM25 score normalised
   within each daemon's batch (cross-daemon BM25 scores are not
   directly comparable; we use a simple "round-robin top-N from
   each daemon, then global sort within tie-bands").
4. Renders each row with a daemon-name pill.

Clicking a result navigates to the source daemon's UI scrolled to
the event.

Cross-daemon search has the same scope semantics as per-daemon
search: each daemon enforces its own permission filter on its own
results. A token paired with daemon A has no privilege at daemon
B; if daemon B's token is missing or expired, that daemon's
results simply don't appear.

## Per-daemon push

Each daemon issues its own webpush subscription (assumed: a
`POST /rc/webpush/subscribe` endpoint, either pre-existing or
introduced by a separate change). The web client maintains N
subscriptions, one per configured daemon, all under the same
browser-origin's push manager. When a daemon emits a push, the
service worker dispatches an OS notification mentioning the
daemon name in the title: `[workstation-1] Permission requested
in oauth-debug`.

Routing is implicit by subscription origin: the push originates
from daemon B; the service worker has stored a per-subscription
mapping to "this came from daemon B"; the notification body
includes that.

## Decisions

### D1 — Client-side aggregation, never server-side proxying

**Choice**: The aggregator lives entirely in the client. Each
daemon talks only to its paired clients and never to other
daemons.

**Alternative considered**: One daemon hosts a "meta" route that
proxies to others.

**Why**: Proxying inverts trust. The meta daemon would hold tokens
for every other daemon; compromise of it reveals everything.
Client-side fan-out keeps per-daemon tokens isolated and per-
daemon trust scoped. It also keeps daemons stateless about each
other, preserving D6.

**Cost**: The client does N HTTP requests instead of 1 when
aggregating. Acceptable; modern browsers handle this trivially,
and there are at most a handful of daemons in realistic setups.

### D2 — Each daemon's UI runs in its own origin

**Choice**: Switching daemons triggers a full navigation. No
attempt to swap data sources within the same origin.

**Alternative considered**: A single web client SPA that swaps
the active daemon URL internally without navigation.

**Why**: Same-origin isolation is the only honest boundary.
Daemon A's served JavaScript runs in origin A's context and can
read `localStorage[qwen-rc:A:token]` only. Daemon B's token is
under daemon B's origin and is unreachable. If we tried a single-
origin multi-daemon SPA, all tokens would live under one origin
and a compromise of any daemon's served code would touch every
other daemon's tokens.

**Cost**: A short navigation flicker on daemon switch. Acceptable;
the dropdown's `<a>` elements use prefetch hints to make the new
daemon's index instant.

### D3 — Clients-manifest is daemon-served owner-only JSON, not

synchronised across daemons

**Choice**: Each daemon serves `/ui/clients-manifest.json` by
reading the operator's `~/.qwen/rc/clients.toml` directly. The
TOML is the source of truth; daemons don't push or pull from each
other.

**Alternative considered**: A central registry file pushed to
each daemon, or one daemon designated as registry-of-record.

**Why**: The TOML lives in the operator's home directory; every
daemon they run already has filesystem access to it. There's no
need to invent a sync protocol. The daemon's role is just to make
the file readable to its own web client (owner scope only). If
the operator edits the TOML, every daemon picks it up on next
read.

**Cost**: A few daemons reading the same file. Each daemon also
needs to know it can read this file even when its own workspace
isn't represented; the file's contents are operator-owned, not
workspace-owned.

### D4 — Tokens stored in OS keyring (terminal) / localStorage

(web)

**Choice**: Terminal client persists tokens in the OS keyring
(macOS Keychain, libsecret on Linux, Credential Manager on
Windows). Web client uses `localStorage` per daemon's origin.

**Alternative considered**: Put tokens in `clients.toml`
plaintext.

**Why**: Tokens are long-lived (30 days, sliding renewal). A
plaintext file is the wrong place for them; the keyring is the
right place. Web clients have no keyring; `localStorage` per
origin is the available isolation primitive there.

**Cost**: A keyring dependency in the terminal client. Documented;
graceful fallback to `~/.qwen/rc/<name>.token` mode-0600 file
when keyring is unavailable (with a stderr warning).

### D5 — Health polling, not push, for switcher dots

**Choice**: Web client polls `GET /health` on each daemon every
30 s (configurable, min 10 s). No SSE-based health stream.

**Alternative considered**: Long-poll or SSE health.

**Why**: `/health` is unauthenticated on loopback per
`add-remote-control`; for non-loopback it allows the token check.
Polling is robust to network changes (tunnel up/down) and doesn't
hold a per-daemon connection open for every browser tab. 30 s is
a sensible compromise between staleness and traffic.

**Cost**: A small periodic burst of N GETs per tab. Acceptable.

### D6 — Aggregated search merges client-side, no cross-daemon

ranking

**Choice**: Each daemon does its own search; the client tags and
merges. We do NOT attempt to compute a globally-fair BM25 across
daemons.

**Alternative considered**: Server-side aggregation with global
ranking.

**Why**: Global ranking would require shared term statistics
across daemons, which violates D1 (server-side proxying) and is
ill-defined when daemons have wildly different corpus sizes. The
client's "round-robin top-N + tie-band sort" is honest about
the limitation and prevents one daemon's high-volume corpus from
drowning out a low-volume daemon's relevant hit.

**Cost**: Aggregated ranking is approximate. UI signals this with
the "(approximate cross-daemon ranking)" footer note.

### D7 — Adding a daemon is an explicit trust gesture

**Choice**: `qwen rc daemons add` runs `/capabilities` first to
verify the URL speaks the protocol, then walks the pairing flow,
and ONLY then writes the entry. No implicit add via "you visited
the URL and it worked." Adding via the web client's "Add a daemon"
flow has the same steps.

**Alternative considered**: A friendlier "click to add" from any
discovered daemon URL.

**Why**: Adding a daemon means "this daemon may serve JS to my
browser when I open its UI." That's a real trust step; making it
explicit prevents accidental adds. Documented in the CLI prompt
and the web client confirmation modal.

**Cost**: Adding is two minutes of work, not two seconds.
Acceptable.

## Persistence

| Artifact                                      | Format | Notes                                                                  |
| --------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `~/.qwen/rc/clients.toml`                     | TOML   | Operator-owned list. Edited via CLI or by hand.                        |
| OS keyring entries (per daemon)               | Native | `tokenStorageKey` indexes into keyring.                                |
| `localStorage[<tokenStorageKey>]` (web)       | String | Per-daemon-origin token (already from `add-remote-control` Phase 4.2). |
| `localStorage["qwen-rc:clients"]` (web)       | JSON   | Cached manifest; refreshed every 5 minutes.                            |
| `localStorage["qwen-rc:active-daemon"]` (web) | String | Last-selected daemon name, per browser-origin.                         |
| Service worker per-subscription mapping       | Native | Per-daemon push subscription metadata.                                 |

## Threat model

| Attacker                                                | Capability                                             | Mitigation                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious daemon added to registry                      | Serves arbitrary JS in its own origin                  | Documented trust step; the malicious JS runs only in its origin. It CANNOT read other daemons' tokens (different origins).                                                    |
| Malicious daemon impersonates another                   | URL spoofing / DNS hijack                              | Daemon URL is set by operator; TLS termination is operator's job; pairing happens against the spoofed URL → operator notices wrong workspace; pairing fails or is suspicious. |
| Daemon A reads daemon B's token                         | Cross-origin XHR with credentials                      | No; tokens stored under daemon B's origin's localStorage, unreachable from daemon A. CORS preflight on B requires explicit allow-list entry, which is operator-controlled.    |
| Operator clicks malicious switcher link                 | `<a href="evil">` injected into legitimate daemon's UI | The switcher is server-rendered from the operator's own manifest; it does not embed external content. If an XSS landed in a legitimate daemon's UI, that's a daemon-A bug.    |
| Aggregated search leaks one daemon's content to another | Cross-daemon visibility                                | Each daemon enforces its own scope filter on its own results; client merges only what each daemon willingly returns. No cross-daemon ACL traversal possible.                  |
| Token expiry on one daemon                              | Aggregated views silently fail for that daemon         | Switcher shows red dot; CLI surfaces the error; aggregated view renders an "auth failed — re-pair" affordance.                                                                |
| `clients.toml` tampering on disk                        | Adding rogue daemon entries                            | File mode 0600; documented in setup. Local-only threat; out-of-scope to mitigate fully (no signed registry).                                                                  |
| Service worker persists past daemon removal             | Removed daemon still pushes                            | When a daemon is removed from registry, the CLI unsubscribes from its push and the web client tears down the corresponding service-worker push subscription on next load.     |
| Network attacker between operator and a daemon          | Read/modify cross-origin XHR                           | TLS via the operator's network layer (already required by `add-remote-control` for non-loopback). The aggregator inherits this assumption.                                    |

### What this change does NOT defend against

- A compromised daemon's web client can lie to the user within
  its own origin; we don't (and can't) defend against that. The
  defence is: only add daemons you trust to run code in your
  browser.
- A malicious operator who edits `clients.toml` to point at a
  honeypot. Operator vs operator is out of scope.

## Risks / Trade-offs

| Risk                                       | Likelihood | Impact | Mitigation                                                                                        |
| ------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------------- |
| Operators confused which daemon they're on | M          | L      | Switcher always visible; daemon name in title bar; coloured banner on aggregated views.           |
| Health polling burns battery on mobile     | M          | L      | Pause polling when tab is backgrounded; 30 s default; per-daemon configurable.                    |
| Cross-daemon search merge looks unfair     | M          | L      | UI labels result as "approximate cross-daemon ranking"; per-daemon view is one click away.        |
| Adding a daemon via CLI fails partway      | L          | M      | Atomic write of `clients.toml`; pairing happens before write; rollback on pairing failure.        |
| OS keyring missing                         | L          | M      | Graceful fallback to mode-0600 file; loud stderr warning.                                         |
| Manifest stale across daemon-add           | M          | L      | 5-minute refresh; manual "Reload daemons" in switcher.                                            |
| Two daemons on the same host:port          | L          | L      | URL is the unique key; the registry rejects duplicate URLs.                                       |
| Push deduplication across daemons          | L          | L      | Each push is independent; service worker shows them all. Operator can mute per daemon via the OS. |

## Open questions

1. **Should daemons be encouraged to share a `workspace` identity
   string?** Currently each daemon's workspace is its cwd; the
   aggregated view shows session names. Worth exposing a
   workspace label in `/capabilities` so the switcher and
   sessions list can show "side-project (~/proj/side)" rather
   than just the daemon name. Probably yes — minor add.

2. **CLI command shape for aggregated search.** `qwen rc search
query "<q>" --across-all` fans out via the CLI. Should it run
   serially or in parallel? Parallel; bounded by max-in-flight to
   avoid swamping when the operator has lots of daemons.

3. **Switching daemons mid-session.** Currently switching
   navigates away from the active session view. We could persist
   "open the same session name in the new daemon" but session
   names aren't unique across daemons, so the heuristic is
   fragile. Leaning no; the switcher takes you to the new
   daemon's default landing.

4. **First-class "import a daemon URL" via deep link.** A
   `qwen-rc://add?url=https://…&name=…` URL handler would let
   operators paste a daemon spec into their browser and have the
   web client offer to add it. Out of scope for v1; add via
   follow-up if demand emerges.

5. **Health endpoint stability without auth.** `/health` is
   unauthenticated on loopback; for tunneled daemons it may
   require auth. Switcher must handle both. Currently we attempt
   `/health` without token first; on 401, we retry with the
   stored token for that daemon. Two requests per poll cycle in
   the auth-required case; acceptable.

6. **What happens to per-daemon push when offline?** If a daemon
   is unreachable, the service worker still holds the
   subscription; messages queue at the push provider. When the
   daemon returns, queued messages may arrive late. Acceptable.

7. **Compatibility with `add-link-share` URLs.** A share URL is
   tied to one daemon's origin. The multi-workspace client does
   not aggregate shares (no list of "all guests across daemons");
   that's deliberately out of scope.
