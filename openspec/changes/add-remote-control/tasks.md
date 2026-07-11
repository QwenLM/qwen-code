# tasks — add-remote-control

This plan is a **living state machine**. Every task's `Status` line is
the source of truth. Whoever runs a task updates the status before and
after the work. Drift between plan and implementation is repaired in
the alignment task (`N.0`) of the next phase.

## State machine

Each task carries a `Status` line whose value is one of:

| Value                | Meaning                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `not-started`        | Default. No work begun.                                                                    |
| `started`            | Active work in progress. Set this BEFORE any other tool call for the task.                 |
| `completed`          | Acceptance criteria in the task's `Prompt` are met; downstream tasks may proceed.          |
| `deferred:<reason>`  | Intentionally postponed. Downstream tasks must check this is acceptable before proceeding. |
| `skipped:<reason>`   | Decided not to do. Spec deltas affected by this task SHOULD be revised in alignment.       |
| `cancelled:<reason>` | Abandoned mid-flight. Partial work left behind MUST be documented in the reason.           |

## Alignment task pattern (`N.0`)

The first task of every phase is alignment. Its prompt always:

1. Reads `tasks.md` and verifies all tasks in prior phases are
   `completed` OR have a `deferred|skipped|cancelled` reason that does
   not block this phase.
2. Verifies the artifacts those tasks produced still exist (files,
   commands, configurations).
3. Compares current code/state to the spec deltas under
   `openspec/changes/add-remote-control/specs/`. If reality has drifted
   (a requirement is now wrong, an endpoint was renamed, a scope was
   added), it edits the affected spec delta AND propagates the change
   through `proposal.md`, `design.md`, and any downstream task prompt
   that references the changed element. This is "self-healing."
4. Records any drift it patched as a comment under the alignment task
   itself, dated.
5. Only after alignment is clean, this task is set `completed` and the
   phase proceeds.

---

## Phase 0 — Foundation

**Goal:** Get a clean working baseline of qwen-code Stage 1, with CI
green, against which all later phases diff.

**Effort:** ~1–2 days.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > This is the project's first task; the "prior phases" section is
    > empty by definition. Still perform the verification pass:
    >
    > - Confirm `openspec/changes/add-remote-control/` contains the
    >   four files this plan references: `proposal.md`, `design.md`,
    >   `tasks.md`, and four spec deltas under `specs/`.
    > - Run `openspec validate add-remote-control --strict` if the
    >   `openspec` CLI is installed; otherwise note that it is not
    >   installed and continue.
    > - Verify upstream qwen-code is on a known Stage 1 commit
    >   (`git log -1` should reference PR #4113 or later but no Mode A
    >   work). Record the commit SHA in this task as
    >   `BASELINE_SHA=<sha>` for downstream reference.
    > - Set this task to `completed` only when the four files exist
    >   and the baseline SHA is recorded.

- [ ] **0.1 Fork qwen-code and create a feature branch**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Fork `QwenLM/qwen-code`. Branch from the SHA recorded in 0.0 as
    > `feature/remote-control`. Push the branch. Confirm CI passes on a
    > no-op commit. Set status `completed` when the branch is pushed
    > and CI is green.

- [ ] **0.2 Reproduce Stage 1 multi-client attach locally**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > Build the branch from 0.1. Run `qwen serve --hostname 127.0.0.1
--port 4170 --token $(openssl rand -hex 16)` in one terminal. > From two other terminals, post `POST /session` with the same > workspace, then `POST /session/:id/prompt` from one and > subscribe to `GET /session/:id/events` from the other. Confirm > prompts and `session_update` events fan out. Record any > divergences from `docs/developers/qwen-serve-protocol.md` in > this task body for the alignment phase of Phase 1 to consider.

- [ ] **0.3 Add a docker-compose harness for the test setup**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > In `/data/qwen-remote-control/harness/`, add a `docker-compose.yml`
    > that runs (a) the daemon image built from the feature branch and
    > (b) a Caddy reverse proxy in front with self-signed TLS. Use
    > `/data/port-manager.sh api` to allocate ports. Add a brief
    > `README.md` explaining `make up` / `make down`. The harness must
    > be reproducible by a fresh contributor in under 60 seconds.

---

## Phase 1 — MVP round-trip

**Goal:** Single shared token, audit log skeleton, `qwen rc serve` and
`qwen rc attach` commands, multi-client sync working over loopback. No
pairing, no web client, no WAL. Proves the architectural shape (D1)
end to end.

**Effort:** ~4–6 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 tasks are all `completed` or have non-blocking
    > deferral reasons. Verify the docker harness from 0.3 starts.
    > Compare the spec deltas to current upstream Stage 1 reality:
    >
    > - Does `docs/developers/qwen-serve-protocol.md` still match the
    >   endpoints in `specs/wire-protocol/spec.md`?
    > - Does the Stage 1 SSE envelope shape match `specs/wire-protocol`
    >   `Requirement: SSE event envelope`?
    > - If not, edit the spec delta to match reality, note the change
    >   in this task body, and update any downstream task prompt that
    >   references the changed shape.

- [ ] **1.1 Add `qwen rc` command surface (alias to `qwen serve` plus
      new subcommands)**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/commands/rc/index.ts`,
    `packages/cli/src/commands/rc/{serve,attach,pair,tokens,audit}.ts`
  - **Prompt:** > Add a top-level `rc` subcommand to the qwen CLI with these > children: `serve` (proxies to existing `qwen serve` with extra > flags), `attach [sessionId|name]`, `pair`, `tokens`, `audit`. The > `serve` and `attach` subcommands must be functional in this > phase; `pair`, `tokens`, `audit` may stub-print `not yet
implemented`. Wire the parser; no behavior changes to `qwen
serve` yet. Set `completed` when `qwen rc serve --help` and > `qwen rc attach --help` print plausible help text.

- [ ] **1.2 Audit log writer (skeleton)**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/remoteControl/audit.ts`,
    integration in `packages/cli/src/serve/server.ts`
  - **Prompt:** > Implement an append-only JSONL audit writer at > `~/.qwen/rc/audit.log` with daily rotation > (`audit-YYYY-MM-DD.log`). Hook every authenticated request to > log `{id, ts, tokenId, ip, method, path, sessionId?, action,
outcome, durationMs}`. In Phase 1, `tokenId` is the literal > string `shared-bearer` (we have no per-client identity yet). > Implement crash-safe recovery per > `specs/pairing-auth/spec.md` `Requirement: Audit log captures
all material actions`, scenario "Audit append survives daemon > crash". Set `completed` when a 1000-request smoke test produces > a valid JSONL file and crash injection during a write recovers > on next start.

- [ ] **1.3 `audit_event` SSE mirror**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/eventBus.ts`,
    `packages/cli/src/serve/remoteControl/audit.ts`
  - **Prompt:** > When the audit writer records a `material: true` action, emit a > corresponding `audit_event` SSE frame to every subscriber on the > session it touches (or to all sessions if the action is daemon- > wide, e.g. token mint). Frame shape per > `specs/wire-protocol/spec.md` `Requirement: New event types
beyond Stage 1`. Verify with the harness from 0.3: two > subscribers, one prompt → both subscribers see one > `audit_event`.

- [ ] **1.4 Thin terminal client `qwen rc attach`**
  - **Status:** not-started
  - **Effort:** ~2 days
  - **Files:** `packages/cli/src/commands/rc/attach.ts`,
    `packages/cli/src/ui/RemoteSession.tsx`, refactor existing
    `packages/cli/src/ui/ChatSurface.tsx` to accept either an
    in-process ACP source or an HTTP+SSE source.
  - **Prompt:**
    > Lift the upstream TUI's chat-rendering layer into a source-
    > agnostic component. Implement an HTTP+SSE source that drives the
    > same component. `qwen rc attach` connects to the local daemon
    > (or the one specified by `--server <url>` + `--token <bearer>`),
    > posts `/session` to attach to the workspace's session,
    > subscribes to `/session/:id/events`, and renders. Input goes to
    > `POST /session/:id/prompt`. Approvals go to
    > `POST /permission/:requestId`. Ctrl-D detaches; `:end` ends.
    > Implement the local-only slash command split per
    > `specs/clients/spec.md`. Acceptance: a manual test where two
    > `qwen rc attach` instances on the same workspace stay in sync
    > and either can approve a tool call.

- [ ] **1.5 SSE through Caddy smoke test**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Use the harness from 0.3. Open one `qwen rc attach` against the
    > Caddy-fronted daemon. Run a 30-minute idle session. Confirm SSE
    > does not get cut by buffering. Document the Caddyfile snippet
    > required (`reverse_proxy` with `flush_interval`). If SSE is
    > unreliable through Caddy, escalate to Phase 5 WS planning early
    > and record it as drift in alignment.

- [ ] **1.6 Cross-client integration test (no phone needed)**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/__tests__/multiClient.test.ts`
  - **Prompt:** > Write an integration test that boots the daemon in-process, > attaches two `DaemonClient` instances, has one post a prompt and > the other observe `session_update` events, then has the agent > issue a fake `permission_request`, has client A approve, and > asserts client B sees the resolved frame with `originatorClientId
= A`. The test must complete in <10 s and not depend on a real > model — stub the ACP child or use a mock service. Acceptance: > test green in CI on the feature branch.

---

## Phase 2 — Pairing, scopes, audit

**Goal:** Replace shared bearer with per-client tokens via pairing
flow. SQLite token store. Scopes enforced. CORS allowlist derived from
paired origins. Owner bootstrap.

**Effort:** ~5–7 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify all Phase 1 tasks are `completed`. Specifically check
    > that the audit writer logs with the `shared-bearer` placeholder
    > (we are about to replace it). Re-read
    > `specs/pairing-auth/spec.md` and compare to what the team
    > learned in Phase 1: did any auth assumption break? If the
    > scope hierarchy needs revision, update the delta first, then
    > propagate to `design.md` `Decisions → D2`. Run
    > `openspec validate add-remote-control --strict` if available.

- [ ] **2.1 SQLite token store**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/remoteControl/tokenStore.ts`,
    `packages/cli/src/serve/remoteControl/schema/001_init.sql`
  - **Prompt:** > Add a SQLite schema with tables `tokens(id PK, hash, name,
scopes, origin, user_agent, created_at, expires_at,
revoked_at, last_used_at)` and > `pairing_codes(code_hash PK, scope, ttl_sec, expires_at,
redeemed_at, issued_by_token_id)`. Tokens are stored Argon2id- > hashed, salt per row. Schema version row in a separate > `meta` table. Add forward-only migration system. Acceptance: > unit tests for insert/lookup/revoke and a migration test > applying 001_init to an empty DB.

- [ ] **2.2 Owner bootstrap flow**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/bootstrap.ts`,
    invoked from daemon startup.
  - **Prompt:** > On first daemon startup against an empty token store, generate > a single-use owner bootstrap code (default TTL 300 s). Write it > to stdout AND `~/.qwen/rc/owner-bootstrap.code` with mode 0600. > First successful redemption closes the path and deletes the > file. Implement `qwen rc bootstrap-reset` to invalidate and > regenerate. Acceptance: scenarios in > `specs/pairing-auth/spec.md` `Requirement: Owner bootstrap is
single-use and time-bounded`.

- [ ] **2.3 Pair / redeem endpoints**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/remoteControl/pairingRoutes.ts`
  - **Prompt:**
    > Implement `POST /rc/pair`, `POST /rc/pair/redeem`,
    > `GET /rc/tokens`, `DELETE /rc/tokens/:id` per
    > `specs/pairing-auth/spec.md`. Codes are 9-char Crockford base32
    > rendered as `XXXX-XXXX-X`; codes are stored hashed; redemption
    > is single-use. Implement constant-time comparison for code and
    > token lookups. Acceptance: integration test that mints a code,
    > redeems it, lists the resulting token, revokes it, and confirms
    > a subsequent request with the revoked token returns 401.

- [ ] **2.4 Scope enforcement middleware**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/remoteControl/scopeGuard.ts`,
    edits to every route handler in `server.ts`.
  - **Prompt:** > For every existing route plus the new ones, declare its > required scope per the table in `design.md` `Auth & threat
model → Pairing flow → Scopes`. Implement middleware that > checks the token's scopes (with hierarchy `owner ⊃ write ⊃
read` and `approve ⊃ read`) and emits a `403` with code > `scope_required: <scope>` on failure. Update audit writer to > log the deciding token id from this middleware. Replace the > `shared-bearer` placeholder in audit writes. Acceptance: scope > scenarios in `specs/pairing-auth/spec.md` `Requirement: Scope
hierarchy and enforcement` pass as integration tests.

- [ ] **2.5 CORS allowlist from paired origins**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/cors.ts`
  - **Prompt:**
    > Replace Stage 1's CORS-deny with an allowlist computed from
    > distinct origins in the token store (`origin` column populated
    > at redemption time from the `Origin` header). Owner can override
    > with `qwen rc cors add <origin>` / `cors remove <origin>` (write
    > to `~/.qwen/rc/config.toml`). Acceptance: web client from a
    > paired origin gets through preflight; unknown origin does not.

- [ ] **2.6 Audit query endpoint**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/auditRoutes.ts`
  - **Prompt:** > Implement `GET /rc/audit` per > `specs/wire-protocol/spec.md` `Requirement: Audit query
endpoint`. Owner-scope only. Filters: `since` (id or ISO > timestamp), `limit` (max 1000), `tokenId`. Read from the > append-only JSONL log; do not load the whole file in memory. > Acceptance: query against a log with 100k rotated entries > returns within 500 ms when filtered.

- [ ] **2.7 TLS-required-on-non-loopback default**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > Implement the startup check in > `specs/pairing-auth/spec.md` `Requirement: TLS required for
non-loopback bind`. `--tls-cert`/`--tls-key` flags or > `--insecure-no-tls` must be present; otherwise refuse boot. > Insecure mode emits the documented warnings.

---

## Phase 3 — Terminal client polish

**Goal:** Bring `qwen rc` to feature-parity with vanilla `qwen` for
the parts that matter, plus the remote-control extras (presence,
audit feed, detach UX, slash split).

**Effort:** ~3–5 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 is `completed`. Specifically: paired tokens
    > exist and audit writes carry real `tokenId` values. Re-read
    > `specs/clients/spec.md` and check for any drift against the
    > Phase 1 thin client. If the Phase 1 client diverged (e.g., the
    > slash-command split was not actually implemented), open a
    > drift note and patch the spec or the implementation.

- [ ] **3.1 Presence indicator**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Subscribe to `client_joined` / `client_left` events. Render a
    > collapsible "Attached: 3 (this, Laptop, Phone)" indicator in
    > the TUI footer. Hover (or `:who` slash) expands to show
    > scopes and last-seen.

- [ ] **3.2 Slash command split implementation and lint**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Prompt:** > For each slash command in the upstream TUI, classify as local- > only or daemon-broadcast per > `specs/clients/spec.md` `Requirement: Local-only slash commands
handled in the client`. Add a typed registry so future commands > must declare a classification. Broadcast commands generate a > `ui_command` event; local-only do not touch the daemon. > Acceptance: a test runs every registered command and asserts > the network behavior matches the classification.

- [ ] **3.3 Detach / reattach UX**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Implement `Ctrl-D` detach and `:end` terminate per spec. Add a
    > startup behavior: `qwen rc attach` with no args attaches to the
    > workspace's existing session (Stage 1 default) and prints a
    > `Resuming session <name> (last activity: <relative>).` banner.
    > `qwen rc attach <sessionId|name>` selects explicitly.

- [ ] **3.4 Audit feed view (terminal)**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Add a `:audit` slash that opens a scrolling read-only pane of
    > the live `audit_event` stream (last 100 events, autoscroll
    > unless user scrolls up). Owner scope only. Useful for watching
    > what other clients are doing.

- [ ] **3.5 `@`-autocomplete via daemon `/files`**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Prompt:**
    > Implement file-path autocomplete by calling
    > `GET /files?glob=…&limit=…` against the daemon. Cache for 5 s.
    > Acceptance: typing `@src/<TAB>` against a real workspace
    > completes within 100 ms on loopback. Confirm path-traversal
    > input is rejected at the client level too (defense in depth).

---

## Phase 4 — Web client

**Goal:** Static HTML+JS bundle at `/ui` with chat, tool cards,
approve/deny, slash palette, file tree, diff viewer, reconnect.

**Effort:** ~7–10 days.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Inspect the current daemon's CORS
    > behavior end-to-end against the local web origin chosen for the
    > bundle (e.g., `https://qwen.local:4170`). Confirm the daemon's
    > capability response advertises `pairingEnabled: true` and the
    > web client design's assumptions still hold. Patch
    > `specs/clients/spec.md` if any UX requirement is impractical
    > (e.g., mobile-Safari SSE behaviors that didn't pan out).

- [ ] **4.1 Build setup (vanilla TS + esbuild)**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/web-client/package.json`,
    `packages/web-client/esbuild.config.mjs`,
    `packages/web-client/src/main.ts`
  - **Prompt:**
    > Vanilla TS, no framework. Single `esbuild` step produces
    > `dist/{app.js, app.css, index.html, assets/*}`. Daemon serves
    > the contents of `dist/` at `/ui/*`. No CDN, no Google Fonts,
    > nothing external. Acceptance: `pnpm build` produces a bundle
    > under 200 KB gzipped excluding fonts.

- [ ] **4.2 Pairing screen**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > A no-token first-load shows only a code-entry field
    > (XXXX-XXXX-X format with dash auto-insertion) and a "Scan QR"
    > button on mobile (`navigator.mediaDevices.getUserMedia` with
    > BarcodeDetector where available; fall back to manual entry).
    > Successful redemption stores the token in
    > `localStorage["qwen-rc:<origin>:token"]`.

- [ ] **4.3 SSE client over fetch-streaming**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/web-client/src/transport/sseClient.ts`
  - **Prompt:** > Implement a header-capable SSE reader using `fetch` + > `ReadableStream`. Handle reconnect with `Last-Event-ID`, the > `replay_truncated` event (per > `specs/clients/spec.md` `Requirement: Web client reconnects
after sleep or transient outage`), and tab-visibility-change > driven reconnects. Backoff 1s → 2s → 4s → 8s capped 30s. > Acceptance: a Vitest test (using an in-memory fetch mock) > exercises: clean stream, drop+reconnect, replay-truncated.

- [ ] **4.4 Transcript + tool-call cards**
  - **Status:** not-started
  - **Effort:** ~1.5 days
  - **Prompt:**
    > Render `session_update` chunks as assistant text. Render
    > tool calls as cards with name, args summary, status spinner →
    > result. Stream tokens character-by-character (or batched per
    > rAF). Auto-scroll-to-bottom with a sticky-up affordance like
    > GitHub PR comments.

- [ ] **4.5 Permission approve/deny UI**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Prompt:**
    > On `permission_request`, render a prominent card with name,
    > arg summary, and (for file-edit tools) a syntax-highlighted
    > diff fetched via `GET /files/content` for context lines.
    > Approve/deny buttons disabled until the user scrolls past the
    > visible diff (mobile only). On `permission_resolved` (own or
    > someone else's), transition to the resolved state showing
    > who voted.

- [ ] **4.6 Slash command palette**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > `/`-prefix in the input opens a command list (commands with
    > daemon-broadcast classification from Phase 3.2). Selecting a
    > command sends it to the daemon. Local-only commands are not
    > listed in the web palette (they require local TUI).

- [ ] **4.7 Read-only file tree**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Prompt:**
    > Lazy-expand tree backed by `GET /files?glob=<dir>/*`. Max depth 4. Clicking a file opens a syntax-highlighted preview pane
    > (via `/files/content`). No editing.

- [ ] **4.8 Presence and audit feed**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Sidebar widget showing attached clients (from `client_joined`
    > / `client_left`). Below it, a "Recent" pane showing the last
    > 20 material `audit_event`s with one-line summaries
    > ("Phone approved edit_file src/foo.ts").

- [ ] **4.9 PWA manifest and offline shell**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Add a manifest so the page is installable. Service worker
    > caches the static shell so offline reload shows a "Connecting…"
    > skeleton rather than the browser error page. Do NOT cache
    > tokens, transcripts, or any session state. Pass Lighthouse
    > PWA installability checklist.

---

## Phase 5 — Durability and transport robustness

**Goal:** Bounded on-disk WAL, WS upgrade path, replay across daemon
restart.

**Effort:** ~4–6 days.

- [ ] **5.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 4 `completed`. Measure: how long do real reconnect
    > scenarios take to recover? Are there event-id gaps the
    > web client treats as fatal? If yes, fix or revise the spec.
    > Confirm Caddy/Nginx behavior with SSE is still healthy after
    > Phase 4 traffic patterns; if not, escalate WS to higher
    > priority within this phase.

- [ ] **5.1 WAL writer behind the event bus**
  - **Status:** not-started
  - **Effort:** ~1.5 days
  - **Files:** `packages/cli/src/serve/remoteControl/wal.ts`,
    `packages/cli/src/serve/eventBus.ts` (hook)
  - **Prompt:**
    > For every event emitted via the event bus, mirror to
    > `~/.qwen/rc/wal/<sessionId>.log`. Length-prefixed JSON lines
    > (4-byte big-endian length, then JSON) for fast tail scanning.
    > Rotate to `<sid>.log.1` when size exceeds 16 MiB; delete
    > segments older than the time horizon. Acceptance: write
    > 100k events under load and verify length-prefix integrity.

- [ ] **5.2 WAL-backed reconnect replay**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Prompt:**
    > On `Last-Event-ID` reconnect, prefer in-memory ring; on miss,
    > scan WAL from the matching id forward. If older than the
    > earliest WAL entry, return `412 Precondition Failed` with a
    > `replay_truncated` event body. Acceptance: scenario "Reconnect
    > after daemon restart replays from WAL" in
    > `specs/remote-session-host/spec.md`.

- [ ] **5.3 WS upgrade endpoint**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Prompt:** > Add `GET /session/:id/ws` accepting `Sec-WebSocket-Protocol:
qwen-rc.v1`. Message bodies are identical JSON to SSE. Honor > `?lastEventId=<hex>` for replay. Authentication is the same > `Authorization: Bearer` header. Add a web-client transport > switch (`preferTransport: "ws"|"sse"`) selectable in settings.

- [ ] **5.4 Long-running torture test**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Prompt:**
    > Run the harness for 24 h with a synthetic agent emitting one
    > event/sec. Detach + reattach every 5 min. Restart daemon
    > every 2 h. Verify zero replay gaps, zero crashes, WAL stays
    > under bounds. Capture and attach a metrics summary to this
    > task.

---

## Phase 6 — Hardening, packaging, docs

**Goal:** Production-quality release on the feature branch. Security
review. Docs. Distribution decision.

**Effort:** ~4–6 days.

- [ ] **6.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 5 `completed`. Compare every spec delta line-by-
    > line to actual behavior. Any divergence must result in an edit
    > to the spec delta (or to the code), recorded as drift notes in
    > this task.

- [ ] **6.1 Security review**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Prompt:**
    > Walk through every entry in the threat-model table in
    > `design.md`. For each, write a test that verifies the
    > mitigation is in place (negative test where possible). Pay
    > special attention to: TLS-required default, path traversal in
    > `/files`, token leak via URL, CORS bypass, audit-log
    > tamper-evidence. Use the project's `/security-review` skill if
    > available.

- [ ] **6.2 Reverse-proxy compatibility matrix**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Prompt:**
    > Spin up the harness behind each of: Caddy, Nginx, Cloudflare
    > Tunnel, Tailscale Serve. For each, run the multi-client test
    > from 1.6 and the long-running test from 5.4 (shortened to 1 h).
    > Produce a `docs/reverse-proxy.md` with required configuration
    > snippets and known caveats.

- [ ] **6.3 Operator docs**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `docs/users/remote-control.md` (new)
  - **Prompt:**
    > Write a single operator-facing guide covering: install, first-
    > run bootstrap, pairing a phone, pairing a teammate, revoking,
    > rotating, reading the audit log, surviving daemon restart, the
    > reverse-proxy options from 6.2. Aim for under 1500 words. No
    > tutorial fluff.

- [ ] **6.4 Decision: upstream PR or sidecar repo**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Review the size of the diff against `QwenLM/qwen-code` main.
    > Decide between (a) opening a PR upstream, (b) keeping the fork,
    > (c) extracting non-fork-requiring pieces into a sidecar daemon
    > that talks to `qwen serve`. Record the decision in
    > `design.md` `Decisions` as `D7`. If (a), open the PR; if (c),
    > document the sidecar architecture.

- [ ] **6.5 Archive this OpenSpec change**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Once shipped, run `openspec archive add-remote-control`. This
    > merges the spec deltas into `openspec/specs/<capability>/spec.md`
    > files and moves the change folder to `archive/`. Verify the
    > merge produced sensible canonical specs.

---

## Cross-cutting test plan (no phone required)

Each is a runnable artifact, not a manual check. All belong to
specific phase tasks above but are summarized here so the test
strategy is legible at a glance.

| Test                         | Phase | Mechanism                                                                                 |
| ---------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| Two-client sync              | 1.6   | In-process daemon + two `DaemonClient`s; one prompts, the other observes.                 |
| Approval race winner         | 1.6   | Same; race two `/permission/:id` POSTs; assert one 200 one 404.                           |
| Pairing → revoke → 401       | 2.3   | Integration; full pairing cycle.                                                          |
| Scope denial                 | 2.4   | Each route hit with each scope; assert table-driven outcomes.                             |
| CORS allowlist               | 2.5   | Playwright headless from a paired origin and an unpaired one.                             |
| Web client reconnect         | 4.3   | Vitest + fetch mock; close mid-stream, observe Last-Event-ID replay.                      |
| Cross-tab cross-device proxy | 4.x   | Playwright with two browser contexts hitting the same daemon; phone-like viewport on one. |
| WAL replay across restart    | 5.2   | Boot, write 100 events, kill -9 daemon, restart, reconnect with Last-Event-ID, assert OK. |
| Reverse-proxy matrix         | 6.2   | docker-compose with one proxy at a time; run 1.6 test against each.                       |
| Threat-model coverage        | 6.1   | One negative test per threat-model row.                                                   |

---

## Effort summary

| Phase     | Description      | Estimate (days) |
| --------- | ---------------- | --------------- |
| 0         | Foundation       | 1–2             |
| 1         | MVP round-trip   | 4–6             |
| 2         | Pairing + scopes | 5–7             |
| 3         | Terminal polish  | 3–5             |
| 4         | Web client       | 7–10            |
| 5         | Durability + WS  | 4–6             |
| 6         | Hardening + docs | 4–6             |
| **Total** |                  | **28–42**       |
