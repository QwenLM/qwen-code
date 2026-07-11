# tasks — add-session-forking

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 1 (MVP round-trip) and
    > Phase 2 (pairing, scopes) are `completed`. Verify the
    > session manager in `packages/cli/src/serve/server.ts`
    > exposes a public entry point for creating a new session
    > with a non-default sessionId (so we can pass one in for
    > forks) and for hooking JSONL writes at session start. If
    > either is hard-coded, note it here and propose the minimum
    > refactor needed — update
    > `add-remote-control/specs/remote-session-host/spec.md` if
    > the refactor changes any externally visible behaviour.

## Phase 1 — Fork endpoint, JSONL header, lineage map

**Effort:** ~2 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Confirm `add-remote-control`'s
    > JSONL writer can accept a "header" first line emitted by us
    > rather than by upstream's session_start. If not, refactor
    > the writer and patch the relevant spec requirement in
    > `add-remote-control` with a dated drift note.

- [ ] **1.1 `POST /session/:id/fork` route + transcript modes**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/forkRoutes.ts`,
    `packages/cli/src/serve/sessionManager.ts` (refactor as
    needed)
  - **Prompt:** > Implement the endpoint per spec. `write`-scope only. > Validates `fromEventId` is within the parent's JSONL range > and refers to a completed (terminal) event; returns 409 > `fork_mid_prompt` if not. For each mode: > > - `include`: copies parent JSONL lines 1..fromEventId into > the new JSONL, preceded by the fork header. Use streaming > I/O (no full file read into memory). > - `summary`: out-of-band ACP call to the parent's agent > requesting a summary (system prompt provided). 30s > timeout. On fail, 502 `fork_summary_failed`. On success, > writes header + one assistant line with `meta.kind =
"fork_summary"`. > - `empty`: writes header only. > New WAL file at `~/.qwen/rc/wal/<newSid>.log`; first entry > is `session_forked`. New agent child spawns with > `--resume <newSid>`. Acceptance: scenarios under > `Requirement: Fork endpoint` and `Requirement: Transcript
modes`.

- [ ] **1.2 Lineage map**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/lineage.ts`
  - **Prompt:**
    > On daemon startup, walk
    > `~/.qwen/projects/<cwd>/chats/*.jsonl`, read the first line
    > of each, build an in-memory map. On every successful fork
    > endpoint call, update the map atomically. Provide
    > `lineage.getParent(sid)` and `lineage.getChildren(sid)`.
    > Acceptance: unit test boots with 50 mock JSONL files, some
    > with fork headers; map reflects the relationships.

- [ ] **1.3 Lineage in `GET /workspace/:cwd/sessions`**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Extend the existing listing endpoint to add
    > `parentSessionId`, `parentEventId`, `forkedAt`,
    > `transcriptMode`, and a derived `forks: [...]` per session.
    > Acceptance: scenario "Listing includes lineage".

- [ ] **1.4 `GET /session/:id/lineage`**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > New route returning the chain to root, capped at 100
    > levels. Owner / write / read all allowed (read of the
    > target session). Acceptance: scenario "Lineage chain
    > truncates at deleted parent".

## Phase 2 — SSE events + audit

**Effort:** ~1 day.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm
    > `add-remote-control`'s SSE event registry is extensible
    > (new event types can be added without protocol bump if
    > consumers ignore unknown fields). If not, patch the spec.

- [ ] **2.1 `session_forked` (fork stream) + `child_forked`
      (parent stream) events**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Emit `session_forked` on the new session's SSE as its
    > first live event (also recorded as the first WAL entry).
    > Emit `child_forked` on the parent's SSE to all
    > subscribers with at least `read` scope. Both events must
    > be idempotent for replay. Acceptance: scenarios under
    > `Requirement: SSE fork events`.

- [ ] **2.2 Audit entries for fork**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Audit writer records `session.fork` action with
    > `parentSessionId`, `parentEventId`, `transcriptMode`,
    > `newSessionId`, `name`. Mirrored as `audit_event` SSE.

- [ ] **2.3 Name validation + collision policy**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > `name` is optional. If present: ASCII printable,
    > `1..=64` chars, no leading/trailing whitespace. Must be
    > unique within the workspace (across active + ended
    > sessions). Conflict returns `409 Conflict` code
    > `name_taken`.

## Phase 3 — Clients

**Effort:** ~2 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm the web client's
    > message rendering (Phase 4 of `add-remote-control`) exposes
    > a per-message context-menu hook. If not, patch the spec
    > and add the hook.

- [ ] **3.1 "Fork from here" action — web client**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:**
    `packages/web-client/src/components/MessageCard.tsx`,
    `packages/web-client/src/components/ForkDialog.tsx`
  - **Prompt:**
    > Per-message kebab menu adds "Fork from here." Opens a small
    > dialog with mode (radio: include/summary/empty), optional
    > name, and the parent event id (read-only display).
    > Submitting posts `/session/:parentId/fork`. On success the
    > UI navigates to the new session (`/ui/session/<newSid>`).
    > Render lineage breadcrumb in the new session's header:
    > `parent: <parent-name> @ event <id>`.

- [ ] **3.2 "Fork from here" — terminal client (`qwen rc`)**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > Add `:fork` slash with arguments: > `:fork [--from <eventId>] [--mode include|summary|empty]
[--name <name>]`. Defaults: `--from` = the most recent > terminal event; `--mode include`. On success, switch the > attached session to the new fork (effectively a reattach).

- [ ] **3.3 Lineage rendering in session list**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Web client session list groups forks under their parent
    > with a tree-style indent. Terminal client's
    > `qwen rc sessions` likewise. The web client tree is
    > collapse/expand; the terminal renders a static tree with
    > unicode box-drawing.

- [ ] **3.4 `qwen rc fork` CLI shortcut**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/cli/src/commands/rc/fork.ts`
  - **Prompt:** > Top-level: `qwen rc fork <sessionId> --from-event <id>
[--mode include|summary|empty] [--name <name>]`. Same > behaviour as the `:fork` slash but without an attached > session. Prints the new sessionId to stdout.

## Phase 4 — Polish

**Effort:** ~0.5 day.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Check that `summary`-mode
    > forks render their summary message visibly in the new
    > session's transcript (with a "fork summary" pill); patch
    > the spec if any rendering scenario is impractical.

- [ ] **4.1 Integration test: fork → run prompt → verify isolation**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > End-to-end test: create session, run 5 prompts, fork at
    > event 5 with `include`, run a new prompt in the fork,
    > assert parent's JSONL is unchanged. Same for `summary` and
    > `empty`. Acceptance: green in CI.

- [ ] **4.2 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:**
    > Run `openspec archive add-session-forking` once Phases
    > 0–4 are `completed`.

## Effort summary

| Phase     | Description                    | Estimate (days) |
| --------- | ------------------------------ | --------------- |
| 0         | Foundation                     | 0.5             |
| 1         | Endpoint + JSONL + lineage map | 2               |
| 2         | SSE events + audit             | 1               |
| 3         | Clients                        | 2               |
| 4         | Polish                         | 0.5             |
| **Total** |                                | **6**           |
