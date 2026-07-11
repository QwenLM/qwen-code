# tasks — add-idle-suggestions

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 6 `completed`. Verify
    > `add-bridge-protocol` Phase 1 `completed` so the sub-actor
    > regex is in place. Decide how to reconcile system-source
    > sub-actors (e.g. `idle-suggest`) with the bridge regex
    > `^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._:@/+=-]{1,256}$`. Per
    > design D5, propose extending the regex to accept a leading
    > `_` prefix for system internals OR a separate field. Patch
    > `add-bridge-protocol/specs/bridge-protocol/spec.md` accordingly
    > if needed and record the decision.

## Phase 1 — Detector + emitter

**Effort:** ~1.5 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Confirm `session_update.stopReason`
    > is reliably emitted as `end_turn` at agent-turn boundaries in
    > current qwen-code builds. If the field is named differently
    > or unreliable, note here and patch the design before
    > implementation.

- [ ] **1.1 Config file + watcher**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/idle/config.ts`
  - **Prompt:** > Load `~/.qwen/rc/idle.yaml` with the schema from `design.md`. > File-watcher with 250 ms debounce. On parse error keep > previous good config and audit `idle_config_parse_failed`. > Ship a default file. Acceptance: scenarios under `Requirement:
Config file and reload`.

- [ ] **1.2 IdleWatcher per session**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/idle/watcher.ts`
  - **Prompt:**
    > Per-session timer. Cancel on real `/session/:id/prompt`.
    > Start on `session_update.stopReason = end_turn` only when
    > there are no pending `permission_request`s in flight. Fire
    > the synthetic emitter when the timer expires. Acceptance:
    > scenarios under `Requirement: Idle detection`.

- [ ] **1.3 Synthetic prompt emitter**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/idle/emitter.ts`
  - **Prompt:** > Mark next agent call with `attribution.synthetic: "idle-
suggest"`. Submit the operator-configured synthetic prompt. > Wire suppression: transcript writer and SSE fan-out check the > flag and skip the round-trip's `session_update` frames AND > skip JSONL transcript writes. Acceptance: scenarios under > `Requirement: Synthetic round-trip suppression`.

- [ ] **1.4 Per-session rate-limit bucket**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Token bucket sized from `maxSuggestionsPerHour`. When empty,
    > skip the synthetic call and audit
    > `idle_suggest_rate_limited` (deduped per hour). Acceptance:
    > scenario under `Requirement: Rate limit`.

## Phase 2 — Parser + SSE event + toggle

**Effort:** ~1 day.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm sample model outputs to
    > tune the parser's code-fence stripping. Note any patterns
    > observed (e.g. the model prepending "Here are some
    > suggestions:") and decide whether to handle in the parser.

- [ ] **2.1 Response parser + validator**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/idle/parser.ts`
  - **Prompt:**
    > Parser per design "Response parsing" section. On parse
    > failure, audit `idle_suggest_parse_failed` with a short
    > reason and DROP the response entirely (no event emitted).
    > Acceptance: scenarios under `Requirement: Response parsing`.

- [ ] **2.2 `idle_suggestions` SSE event**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:** > Emit the event with the payload shape from `design.md`. > Acceptance: scenario under `Requirement: idle_suggestions SSE
event`.

- [ ] **2.3 `/suggest` slash command + toggle endpoint**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/cli/src/serve/remoteControl/idle/toggle.ts`
  - **Prompt:** > New endpoint `POST /session/:id/idle-suggest-toggle { enabled:
bool }` for write-scope tokens. Built-in `/suggest [on|off|
status]` slash command in clients posts to it. Acceptance: > scenarios under `Requirement: Per-session toggle`.

## Phase 3 — Client rendering + capability

**Effort:** ~0.5 day.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Decide chip count and `expiresAt`
    > default; confirm matches `design.md` (3 chips, 5 min). If
    > usability testing has happened (it usually hasn't this early)
    > adjust.

- [ ] **3.1 Web client chip component**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:**
    `packages/web-client/src/components/suggestionsChips.ts`
  - **Prompt:**
    > Component subscribes to `idle_suggestions`, renders up to 3
    > chips below the input. Tap fills input (no auto-send).
    > Auto-clear at `expiresAt`. Show small "rate limited" indicator
    > on the relevant audit event. Acceptance: scenarios under
    > `Requirement: Client rendering`.

- [ ] **3.2 Terminal chip + `Alt-N` shortcuts**
  - **Status:** not-started
  - **Effort:** ~0.15 day
  - **Prompt:**
    > Render chips inline below the input prompt area. Bind
    > `Alt-1..3` to fill the corresponding suggestion. Same auto-
    > clear behavior.

- [ ] **3.3 Capability advertisement**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:** > Add `idleSuggestions: { enabled, idleAfterSec,
maxSuggestionsPerHour }` to `/capabilities`'s `remoteControl`.

- [ ] **3.4 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.1 day
  - **Prompt:**
    > Run `openspec archive add-idle-suggestions`.

## Effort summary

| Phase     | Description                   | Estimate (days) |
| --------- | ----------------------------- | --------------- |
| 0         | Foundation                    | 0.5             |
| 1         | Detector + emitter            | 1.5             |
| 2         | Parser + event + toggle       | 1               |
| 3         | Client rendering + capability | 0.5             |
| **Total** |                               | **3.5**         |
