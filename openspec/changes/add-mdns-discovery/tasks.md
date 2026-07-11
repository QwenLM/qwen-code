# tasks — add-mdns-discovery

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 1 `completed` (daemon binds
    > network interfaces with a known port). Verify the chosen
    > mDNS library (`bonjour-service`) installs cleanly on the
    > project's supported Node versions and platforms (Linux,
    > macOS, Windows). If install / runtime issues appear on any
    > platform, note here and re-evaluate against `multicast-dns`
    > or another candidate before proceeding.

## Phase 1 — Advertisement

**Effort:** ~1 day.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Confirm there is a single place
    > in daemon startup that knows the resolved bind addresses and
    > the http port. If not, refactor that into one helper before
    > wiring mDNS so the advertisement and the http server agree on
    > the address.

- [ ] **1.1 Advertisement module**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/mdns/advertise.ts`
  - **Prompt:**
    > Wrap `bonjour-service`. Construct service-type
    > `_qwen-rc._tcp.local.` registration with TXT records per
    > `design.md`. Suppress advertisement when bound only to
    > loopback OR when `--no-mdns` / `QWEN_RC_NO_MDNS=1` set.
    > Print one startup line describing what is being advertised
    > (or noting it's disabled). Acceptance: scenarios under
    > `Requirement: Advertisement registration`.

- [ ] **1.2 CLI flags and env var**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Add `--no-mdns`, `--mdns-workspace-name <s>`,
    > `--mdns-instance-name <s>` to `qwen serve`. Wire env var
    > `QWEN_RC_NO_MDNS=1`. Acceptance: each flag overrides as
    > documented; the startup banner reflects the effective state.

- [ ] **1.3 Clean withdrawal on shutdown**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Register SIGINT/SIGTERM handler to call `unpublish()` with a
    > 500 ms grace before exit. Acceptance: scenario under
    > `Requirement: Goodbye on shutdown` — after SIGTERM, an
    > observing host's browse no longer lists the daemon within
    > 2 s.

## Phase 2 — Browse + CLI

**Effort:** ~1 day.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed` on at least one host that other
    > LAN clients can browse. Confirm IPv6 behavior: register and
    > browse on an IPv6-only segment if available. Note any
    > library quirks.

- [ ] **2.1 Browse helper**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/mdns/browse.ts`
  - **Prompt:** > Browse `_qwen-rc._tcp.local.` for `--timeout` seconds. > Collect responses, dedupe by service name, normalize TXT to > structured records (`{ name, host, port, version,
tlsRequired, workspace }`). Acceptance: scenarios under > `Requirement: Browse helper`.

- [ ] **2.2 `qwen rc daemons discover` CLI**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:** > Subcommand printing a table sorted by host then port. Support > `--format json` for scripting. Print a row count and timing > summary line. Acceptance: scenarios under `Requirement:
Discover CLI output`.

- [ ] **2.3 `qwen rc daemons list-self` CLI**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Hits the local daemon's `/capabilities`; prints advertised
    > instance name, bound addresses, mDNS state (on / off /
    > suppressed-loopback). Useful when an operator is debugging
    > "why doesn't my phone see this."

- [ ] **2.4 Capability advertisement**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:**
    > Add `mdns: { advertising: bool, instanceName }` to
    > `/capabilities`'s `remoteControl` block (visible to any
    > authenticated token).

- [ ] **2.5 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:**
    > Run `openspec archive add-mdns-discovery`.

## Effort summary

| Phase     | Description   | Estimate (days) |
| --------- | ------------- | --------------- |
| 0         | Foundation    | 0.5             |
| 1         | Advertisement | 1               |
| 2         | Browse + CLI  | 1               |
| **Total** |               | **2.5**         |
