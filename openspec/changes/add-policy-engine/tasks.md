# tasks — add-policy-engine

State machine and alignment-task pattern: see
`changes/add-remote-control/tasks.md`. Status values:
`not-started | started | completed | deferred:<reason> | skipped:<reason> | cancelled:<reason>`.

## Phase 0 — Foundation

**Effort:** ~1 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 6 is `completed` (or note any
    > deferral that does not block this change). Confirm the daemon
    > exposes a permission handler hook point we can intercept (look
    > at `packages/cli/src/serve/server.ts` permission request flow).
    > If the upstream code has refactored the permission path since
    > the design was written, update this change's `design.md`
    > `Architecture` diagram to reflect the new hook and propagate
    > impact to downstream tasks.

- [ ] **0.1 Decide schema version handling**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Lock the policy schema as v1. Write a JSON Schema in
    > `packages/cli/src/serve/policy/schema/v1.json`. Plan migration
    > strategy: v2+ files declare `version: 2`, loader picks the
    > matching parser. Set `completed` when schema file lints clean.

## Phase 1 — Loader and evaluator (MVP)

**Effort:** ~3–4 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Inspect upstream qwen-code's
    > YAML parser choice — if `js-yaml` is not already a dep, propose
    > adding it. Note the dep choice in this task body.

- [ ] **1.1 YAML loader + schema validator**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/policy/loader.ts`,
    `schema/v1.json`
  - **Prompt:**
    > Load `~/.qwen/rc/policy.yaml` and (if cwd matches) workspace
    > file. Use `js-yaml.safeLoad` (never `load`). Validate against
    > schema v1. On failure, emit structured error including line
    > and column. Acceptance: unit tests for happy path, missing
    > version, unknown action, absolute-path glob, duplicate id,
    >
    > > 1000 rules.

- [ ] **1.2 Specificity-ordered evaluator**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/policy/evaluator.ts`,
    `policy/specificity.ts`
  - **Prompt:** > Compute specificity scores per `design.md` Decisions D6. > Evaluator method: `evaluate(toolCall, ctx) → { action, ruleId
| null, reason? }`. Match supports `tool`, `argsGlob`, > `pathGlob`, `originScope`, `sessionTag`, `timeOfDay`. Use a > glob library that does NOT enable absolute-path globs (or > pre-filter input). Acceptance: table-driven test with 20+ > scenarios covering precedence, fallthrough, and edge cases > from `specs/policy-engine/spec.md`.

- [ ] **1.3 Integrate into permission handler**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/server.ts` (permission route),
    `packages/cli/src/serve/policy/integration.ts`
  - **Prompt:**
    > Call `evaluator.evaluate(toolCall, ctx)` before any
    > `permission_request` SSE emit. On `allow`/`deny`, emit
    > `policy_decision` and resolve the permission directly. On
    > `prompt`, attach `requiredScope` (if present) to the emitted
    > `permission_request`. On any matched rule, write an audit
    > entry with `decision_source: "policy"` and `rule_id`.
    > Acceptance: integration test where (a) an allow rule causes no
    > `permission_request` frame, (b) a deny rule causes no
    > `permission_request` frame and the agent receives
    > `policy_denied`.

## Phase 2 — Quotas and time

**Effort:** ~2 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm the daemon's existing event
    > WAL is reusable for the quota WAL pattern. If the WAL
    > implementation is too narrow (event-specific), update the spec
    > delta to describe a separate quota WAL file and propagate the
    > change to `design.md` Persistence section.

- [ ] **2.1 In-memory + WAL quota counters**
  - **Status:** not-started
  - **Effort:** ~1 day
  - **Files:** `packages/cli/src/serve/policy/quotas.ts`
  - **Prompt:** > Implement rolling-window counters keyed by `(ruleId,
windowStartTs)`. On match-and-execute, append to > `~/.qwen/rc/quotas.wal` and update memory. On daemon start, > replay WAL within retention horizon. Daily rotation. Acceptance: > kill -9 mid-window and verify counter restored.

- [ ] **2.2 expiresAt + timeOfDay evaluation**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > Add `expiresAt` (ISO timestamp) and `timeOfDay` `{from, to,
timezone}` matchers. Use `Intl.DateTimeFormat` with IANA tz. > Wrap correctly around midnight. Acceptance: unit tests for > before/after expiry, before/in/after window, and a wrap-over- > midnight window.

- [ ] **2.3 Quota-falls-through behavior**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:** > When a rule's quota is exhausted, evaluator skips it and tries > the next-most-specific rule. Audit records `rule_skipped:
quota_exhausted` at debug level. Acceptance: scenario > "Rate-limited rule falls through after cap" in > `specs/policy-engine/spec.md`.

## Phase 3 — Hot reload + tooling

**Effort:** ~2 days.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm `chokidar` (or equivalent)
    > is acceptable as a dep on Linux/macOS/Windows. If only certain
    > platforms support fsnotify properly, update `design.md` D4 cost
    > section.

- [ ] **3.1 fsnotify-backed hot reload**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:** `packages/cli/src/serve/policy/hotReload.ts`
  - **Prompt:**
    > Watch both policy file paths. Debounce 250 ms. Reload via
    > loader; on parse error, retain previous ruleset and emit
    > `policy_load_error` SSE to owner subscribers. On success, emit
    > `policy_reloaded` audit event. Acceptance: write a series of
    > rapid edits and confirm exactly one reload occurs.

- [ ] **3.2 `qwen rc policy {reload, explain, lint}` CLI**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Files:** `packages/cli/src/commands/rc/policy/{reload,explain,lint}.ts`
  - **Prompt:**
    > `policy reload` posts a daemon endpoint to force reload.
    > `policy explain <toolName> [--args …] [--path …] [--scope …]`
    > runs the evaluator against a synthetic tool call and prints
    > each rule considered in order with `MATCHED` / `SKIPPED:<why>`
    > annotation. `policy lint <file>` runs the loader without daemon
    > integration. Acceptance: explain output is reviewable and
    > unambiguous.

- [ ] **3.3 World-writable mode warning**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > At startup and on every reload, stat policy files and warn if
    > mode is group- or world-writable. Emit `policy_file_unsafe_perms`
    > audit event.

## Phase 4 — Operator polish + starter rules

**Effort:** ~1–2 days.

- [ ] **4.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 3 `completed`. Gather user feedback / dogfooding
    > notes from internal use. Identify the 3-5 patterns that
    > emerged ("safe tests", "no force push", "no rm -rf outside
    > /tmp"). Update `design.md` open question Q3 status.

- [ ] **4.1 Starter `policy.example.yaml`**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `docs/policy.example.yaml`
  - **Prompt:**
    > Ship a heavily commented example with: safe tests allowlist,
    > force-push denylist, rm -rf denylist outside /tmp, auth-tree
    > owner-only, nighttime quiet. NOT installed automatically —
    > user copies if they want it.

- [ ] **4.2 Web client UI for live policy state**
  - **Status:** not-started
  - **Effort:** ~0.75 day
  - **Prompt:**
    > Add a "Policy" panel to the web client showing the active
    > ruleset (read-only), the last 20 `policy_decision` events, and
    > a quick `explain` form that hits the daemon's explain
    > endpoint. Read-scope tokens see only their own session's
    > decisions; owner sees all.

- [ ] **4.3 Docs**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `docs/users/policy.md`
  - **Prompt:**
    > Write a focused operator guide: rule shape, precedence model
    > with worked example, quotas, expiry, time-of-day, common
    > patterns. Under 800 words.

- [ ] **4.4 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Run `openspec archive add-policy-engine`. Verify the canonical
    > `openspec/specs/policy-engine/spec.md` reads sensibly post-
    > merge.

## Effort summary

| Phase     | Description                      | Estimate (days) |
| --------- | -------------------------------- | --------------- |
| 0         | Foundation                       | 1               |
| 1         | Loader + evaluator + integration | 3–4             |
| 2         | Quotas + time                    | 2               |
| 3         | Hot reload + CLI                 | 2               |
| 4         | Polish + starter rules           | 1–2             |
| **Total** |                                  | **9–11**        |
