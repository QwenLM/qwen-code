# tasks — add-multi-workspace-client

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 2 (pairing, scopes,
    > CORS) and Phase 4 (web client) are `completed`. Confirm
    > the daemon's CORS allowlist is paired-origin-driven (Phase
    > 2.5). If not, that path must work before any cross-origin
    > aggregation is sensible — escalate by patching the
    > relevant spec and adding a downstream blocker note here.
    > Record `BASELINE_SHA=<sha>`.

## Phase 1 — clients.toml + CLI registry

**Effort:** ~2 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Decide on a TOML parser
    > library (likely the same one used elsewhere in qwen-code;
    > if none, pick one and add it). Record the choice.

- [ ] **1.1 clients.toml reader/writer**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/commands/rc/daemons/registry.ts`
  - **Prompt:**
    > Load from `~/.qwen/rc/clients.toml`; create the file with
    > mode 0600 if missing. Schema:
    > `{ daemon: [{ name, url, tokenStorageKey, default? }] }`.
    > Enforce: name uniqueness, URL uniqueness, exactly one
    > default (auto-promote the first entry if absent). Provide
    > `list()`, `getByName()`, `getDefault()`, `upsert()`,
    > `remove()`. Atomic writes via temp-and-rename. Acceptance:
    > unit tests for each operation; corruption-resistance test
    > (kill-9 mid-write leaves a valid file or no change).

- [ ] **1.2 OS keyring abstraction + fallback**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/commands/rc/daemons/tokenStore.ts`
  - **Prompt:**
    > Wrap a keyring library (e.g., `keytar`-equivalent). On
    > platforms where it fails, fall back to writing
    > `~/.qwen/rc/tokens/<sanitised-tokenStorageKey>.tok` mode
    > 0600 and emit a one-time stderr warning. API:
    > `get(tokenStorageKey)`, `set(tokenStorageKey, value)`,
    > `delete(tokenStorageKey)`. Acceptance: works on Linux
    > Secret Service; works in fallback mode when the keyring
    > daemon is absent.

- [ ] **1.3 `qwen rc daemons` CLI subcommand**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/commands/rc/daemons/index.ts`
  - **Prompt:**
    > Subcommands:
    >
    > - `list` — table: name, url, default flag, health (last
    >   known), token presence.
    > - `add <name> <url>` — fetch `<url>/capabilities` first;
    >   reject if not a qwen-remote-control daemon or version
    >   incompatible. Then walk the pairing flow (prints code,
    >   prompts user to paste it). On success, persist registry
    >   entry and token. Prints a trust warning before pairing.
    > - `remove <name>` — confirm; on remove, revoke the token
    >   on the daemon (best-effort `DELETE /rc/tokens/:id`) and
    >   delete the keyring entry.
    > - `set-default <name>` — flip default flag atomically.
    > - `health [--all]` — runs `GET /health` against each
    >   daemon; prints results.
    > - `whoami [--daemon <name>]` — prints token name, scope,
    >   expiry.
    >   Acceptance: scenarios under `Requirement: Registry CLI`.

- [ ] **1.4 `--daemon` flag on every per-daemon CLI**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Threaded through: `qwen rc attach`, `qwen rc pair`,
    > `qwen rc tokens`, `qwen rc audit`, `qwen rc share`,
    > `qwen rc search`, `qwen rc sessions`, `qwen rc bridges`
    > (if `add-bridge-protocol` shipped), `qwen rc fork` (if
    > `add-session-forking` shipped). Default daemon used when
    > omitted. Help text shows the flag.

## Phase 2 — Daemon-side manifest endpoint

**Effort:** ~0.25 day. Yes, this is daemon-side; the rest of the
change is purely client-side.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm the daemon process
    > can read `~/.qwen/rc/clients.toml` (it's the operator's
    > home; same filesystem). Confirm no per-workspace scoping
    > is needed for this file.

- [ ] **2.1 `GET /ui/clients-manifest.json`**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/clientsManifestRoute.ts`
  - **Prompt:**
    > Owner-only endpoint. Reads `~/.qwen/rc/clients.toml` and
    > returns it as JSON. Cache 60 s. Acceptance: scenario
    > "Owner fetches manifest".

## Phase 3 — Web client switcher + aggregated views

**Effort:** ~3 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm the web client's
    > router (or static page set) can host `/ui/sessions` and
    > `/ui/daemons` views. If router refactor is needed, do it
    > here.

- [ ] **3.1 Manifest loader + cache**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/web-client/src/state/daemonsRegistry.ts`
  - **Prompt:**
    > On web client load, fetch
    > `/ui/clients-manifest.json`. Store in `localStorage`
    > under `qwen-rc:clients`; refresh every 5 minutes or on
    > explicit reload. Expose a typed registry to the rest of
    > the UI. Track `activeDaemon` in
    > `localStorage["qwen-rc:active-daemon"]`. Default-on-first-
    > load uses the manifest's default daemon.

- [ ] **3.2 Switcher dropdown in header**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:**
    `packages/web-client/src/components/DaemonSwitcher.tsx`,
    `packages/web-client/src/state/health.ts`
  - **Prompt:** > Dropdown lists every daemon with a coloured dot. Poll > `<url>/health` every 30 s per daemon (pause when tab is > backgrounded). 200 in last 30 s = green; 200 between 30s > and 5m = yellow; failure or 401/403 = red. Switching to > another daemon calls `location.assign(<other>/ui/)`. > Acceptance: scenarios under `Requirement: Daemon
switcher and health polling`.

- [ ] **3.3 Aggregated sessions view at `/ui/sessions`**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:**
    `packages/web-client/src/views/AllSessions.tsx`
  - **Prompt:** > Fan out `GET /workspace/<cwd>/sessions` to each daemon > with its token (cross-origin fetch). Render a unified > table with daemon-name pills. Failures shown as > "UNREACHABLE — last seen <relative>." Each row's "Open" > navigates to the source daemon's `/ui/session/<sid>`. > Acceptance: scenarios under `Requirement: Aggregated
sessions view`.

- [ ] **3.4 Aggregated search toggle**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Extend the search modal from `add-cross-session-search`.
    > Add an "Across all daemons" toggle. When on, fan out the
    > query to each daemon; tag each hit with its daemon name;
    > render daemon-name pill on each row; merge results per
    > "round-robin top-N + tie-band sort." Daemons that error
    > or 401 are listed as a footer note. Acceptance: scenarios
    > under `Requirement: Aggregated cross-daemon search`.

## Phase 4 — Per-daemon push + docs

**Effort:** ~1 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Determine whether webpush
    > exists yet in qwen-code's daemon (from a separate change
    > or upstream). If not, this phase becomes "documentation
    > and stubs" only — note that downstream webpush work
    > should call into the per-daemon naming hooks we add.

- [ ] **4.1 Per-daemon push subscription state**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/web-client/src/state/pushSubscriptions.ts`,
    `packages/web-client/src/sw/notifications.ts`
  - **Prompt:**
    > For each daemon, manage its own webpush subscription.
    > On registry add → subscribe; on remove → unsubscribe; on
    > token-revoke detection → unsubscribe and prompt re-
    > pair. Service worker stores per-subscription metadata
    > `{ daemonName }`. Notification title is prefixed `[<daemonName>]`.
    > Acceptance: notification rendered with daemon name on
    > delivery.

- [ ] **4.2 Operator docs**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `docs/users/remote-control.md` (append)
  - **Prompt:**
    > New "Managing multiple daemons" section. Covers: the
    > registry, the trust step on add, the switcher UX, per-
    > daemon vs aggregated views, the threat model (a malicious
    > daemon serves JS in its own origin; tokens are origin-
    > isolated). Under 500 words.

- [ ] **4.3 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:**
    > Run `openspec archive add-multi-workspace-client` once
    > Phases 0–4 are `completed`.

## Effort summary

| Phase     | Description                 | Estimate (days) |
| --------- | --------------------------- | --------------- |
| 0         | Foundation                  | 0.5             |
| 1         | clients.toml + CLI registry | 2               |
| 2         | Manifest endpoint           | 0.25            |
| 3         | Switcher + aggregated views | 3               |
| 4         | Push + docs                 | 1               |
| **Total** |                             | **~7**          |
