# add-multi-workspace-client

## Why

`add-remote-control` D6 explicitly preserves the rule **one daemon =
one workspace**. That keeps the daemon simple — pairing,
audit, sessions, scopes, search are all unambiguously scoped to
the workspace. Operators with many projects (typical: a personal
dotfiles repo, a side project, a day job repo) end up running N
daemons on N ports.

The cost is on the **client side**: each daemon has its own URL,
its own paired token, its own web client deployment, its own
sessions. The operator has to bookmark `https://qwen.local:4170`
for project A and `https://qwen.local:4171` for project B and
remember which tab is which.

Worse: a session that was started against the wrong workspace
can't be moved; the operator just has to open the other daemon's
URL. There's no aggregated view of "all my sessions across
everything," no unified search, no shared notification surface.

The principled answer is **not** to break D6 by making daemons
multi-workspace. It's to add a **client-side aggregator** that
holds a registry of known daemons and unifies the UX across them.
The daemons remain single-workspace, single-owner, blissfully
unaware of each other. The client's responsibilities are:

- Hold a small config of known daemons.
- Surface them in a switcher.
- Cache each daemon's health (online / unreachable / auth-failed).
- Provide an aggregated sessions view that fans out to all
  daemons.
- Provide aggregated search that queries each daemon's
  `/rc/search` and merges client-side.
- Provide per-daemon push subscriptions (each daemon issues its
  own; the browser is subscribed to N at once).

## What Changes

- **New client config `~/.qwen/rc/clients.toml`.** Lists known
  daemons by name, URL, and a token-storage key (a localStorage
  key namespace, since each daemon has its own paired token).
  Example:

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

- **Web client daemon switcher.** Header dropdown listing each
  daemon with a coloured dot (green = healthy, yellow = degraded,
  red = unreachable / 401). Switching changes which daemon's
  routes the rest of the UI queries. The current daemon is
  persisted in `localStorage` per browser-origin.
- **Aggregated landing page.** "All sessions" view that calls
  `GET /workspace/<cwd>/sessions` on each configured daemon in
  parallel and renders a unified list. Each session row has a
  daemon-name pill so it's obvious where it lives.
- **Aggregated search.** The web client's search modal (from
  `add-cross-session-search`) gains an "across all daemons"
  toggle. When on, the client fans out the same query to every
  daemon, tags each result with its source daemon, and merges
  client-side.
- **Terminal CLI.** `qwen rc attach --daemon <name>` selects a
  specific daemon. `qwen rc daemons {list, add, remove,
set-default, health}` manages the registry. Operations like
  `qwen rc share` operate against the currently-active daemon
  unless `--daemon` is passed.
- **Per-daemon push.** Each daemon's webpush subscription remains
  separate. A browser subscribed to two daemons receives push
  from each independently. Notification UI mentions the source
  daemon by name.
- **Trust model documented.** Adding a daemon to the registry is
  an explicit trust step. The web client served from daemon A
  is in origin A's security boundary; daemon B's origin is
  separate. A compromised daemon serves arbitrary JS in its own
  origin only.

## Capabilities

### New Capabilities

- `multi-workspace-client` — daemon registry, switcher UI,
  aggregated views, per-daemon push, trust documentation, CLI
  `qwen rc daemons`. Entirely client-side; no daemon-side
  changes are required by this capability.

## User Stories

**M1. Switch between daemons in the web client.** Operator has
three daemons. They open `https://qwen.local:4170/ui`. The header
shows a switcher with three entries, each with a dot. They click
"side-project" and the chat view, sessions list, and search now
all target `qwen.local:4171`.

**M2. Aggregated "all sessions" view.** Operator opens
`/ui/sessions` (a new view shipped by every daemon's web client).
The page fans out to all configured daemons and lists every
session, tagged with daemon name and session name. Click → opens
the right daemon's session.

**M3. Find a conversation across all projects.** Operator hits
Ctrl-K, toggles "across all daemons," types `oauth refresh`.
Three results: one from `workstation-1`, two from `side-project`.
Result rows show source daemon as a pill.

**M4. Terminal-side daemon awareness.** Operator runs `qwen rc
attach`. Without args, it attaches to the default daemon. With
`--daemon side-project` it attaches there. `qwen rc daemons
list` prints the registry with health.

**M5. A daemon is offline.** `workstation-1` is down. The
switcher shows it red; the aggregated views skip it and surface
a warning banner; per-daemon operations still work for the other
daemons. When `workstation-1` comes back, the switcher updates
within a poll cycle (30 s default).

**M6. Adding a daemon is a deliberate step.** Operator adds a new
daemon URL via `qwen rc daemons add <name> <url>`. The CLI runs
`/capabilities` against the URL, confirms it speaks the
remote-control protocol, prompts the operator to walk through
the standard pairing flow, and persists the entry plus the
token. The CLI warns: "This daemon will be able to serve
arbitrary JavaScript to your browser when you open its UI; only
add daemons you trust to run code on your behalf."

## Impact

- **qwen-code repo**: no daemon-side spec changes. Web client
  refactor to host a daemon registry, switcher, and aggregated
  views. New CLI subcommand `qwen rc daemons`. The terminal
  client adds `--daemon` to every per-daemon subcommand.
- **Client config**: a new TOML file at `~/.qwen/rc/clients.toml`
  for the terminal client; for the web client, a JSON shape in
  `localStorage["qwen-rc:clients"]` synced from the TOML when
  served by the daemon as a bootstrap payload (`/ui/clients-
manifest.json`, owner-only).
- **Push**: each daemon issues its own webpush keys; the web
  client subscribes to each separately. Notification routing uses
  the existing per-daemon webpush flow (from any prior
  `add-webpush` change or whatever native push delivery is in
  place); this change does not specify push, only that
  notifications carry daemon name.
- **Threat model**: a malicious daemon in the registry can serve
  arbitrary JS in its own origin. This change documents the
  trust step and ensures that the web client served by daemon A
  cannot reach daemon B's auth tokens via DOM access (separate
  origins, cross-origin isolation).
- **Out of scope** (deliberately):
  - Multi-workspace **daemons**. D6 is preserved.
  - Cross-daemon session migration (move a session from A to B).
  - Cross-daemon agent state sharing (no idea what that would
    even mean coherently).
  - A central directory service ("registry of daemons" in a
    cloud). Local file only.
  - Single-sign-on across daemons. Each daemon is its own auth
    domain; pairing is per-daemon.
  - Federated audit. Each daemon's audit is its own log.
  - Daemon discovery (mDNS, etc.). The operator types the URL
    in.
