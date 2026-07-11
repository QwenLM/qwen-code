# tasks — add-custom-slash-commands

State machine and alignment pattern: see
`changes/add-remote-control/tasks.md`.

## Phase 0 — Foundation

**Effort:** ~0.5 day.

- [ ] **0.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify `add-remote-control` Phase 6 `completed`. Confirm the
    > built-in slash-command registry in
    > `packages/cli/src/ui/slashCommands/` exposes a merge point
    > (i.e. we can register an additional registry source without
    > forking the UI code). If it doesn't, note here and revise
    > `add-remote-control/specs/clients/spec.md` to add a
    > pluggable-command-source requirement.

## Phase 1 — Loader + storage

**Effort:** ~1.5 days.

- [ ] **1.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 0 `completed`. Confirm reuse of the same YAML
    > parser + file watcher pattern as `add-policy-engine` and
    > `add-cost-tracking`. If those changes haven't shipped yet,
    > decide whether to lift a shared `~/utils/fileWatcher` helper
    > now or defer.

- [ ] **1.1 Front-matter parser + loader**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:**
    `packages/cli/src/serve/remoteControl/commands/loader.ts`
  - **Prompt:** > Implement `CommandLoader` that scans `<workspace>/.qwen/
commands/*.md` and `~/.qwen/commands/*.md`. Parse YAML > front-matter, validate against the schema in `design.md`, > validate `name` regex, hold body as opaque string. On parse > error, skip the file and emit audit > `slash_command_parse_failed`. Acceptance: scenarios under > `Requirement: Command file format and loading`.

- [ ] **1.2 Hot reload + collision audit**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > File watcher (250 ms debounce). On reload, rebuild the
    > registry; emit `command_collision_workspace_wins` /
    > `command_collision_user_wins` audits for any shadowing.
    > Acceptance: scenarios under `Requirement: Hot reload` and
    > `Requirement: Naming precedence`.

- [ ] **1.3 In-memory registry + listing helper**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > Registry exposes `list(scope)` returning visible commands with
    > the `invocableByYou` flag pre-computed. Stable iteration order
    > (workspace-first, then user, alphabetical within source).

## Phase 2 — Discovery + execution endpoints

**Effort:** ~1.5 days.

- [ ] **2.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 1 `completed`. Confirm the existing
    > `POST /session/:id/prompt` handler has an internal entry point
    > we can call from the slash-command dispatcher (i.e. we don't
    > need to re-implement queueing). Confirm the tool-invocation
    > path has a similar internal entry point for the direct-tool
    > case.

- [ ] **2.1 `GET /rc/commands` route**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/cli/src/serve/remoteControl/commands/route.ts`
  - **Prompt:**
    > Implement listing endpoint. Apply scope clamp at flag
    > computation time so palette can gray-out unavailable commands.
    > Return `X-Commands-Revision: <sha>` header for cheap polling.
    > Acceptance: scenarios under `Requirement: List endpoint`.

- [ ] **2.2 `POST /rc/commands/:name/invoke` route — prompt path**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Files:** `packages/cli/src/serve/remoteControl/commands/invoke.ts`
  - **Prompt:** > Resolve placeholders against the request body; submit via the > internal prompt path; emit audit > `slash_command_prompt_submitted` with command name, args, and > resolved prompt text. Reject with 403 if effective scope is > insufficient. Acceptance: scenarios under `Requirement:
Invoke endpoint — prompt path`.

- [ ] **2.3 Invoke route — direct-tool path**
  - **Status:** not-started
  - **Effort:** ~0.5 day
  - **Prompt:**
    > When `tool:` is set, call the tool through the same
    > permission-request flow the agent uses. Pass resolved args as
    > the tool's argv. Audit event
    > `slash_command_tool_invoked`. Acceptance: scenarios under
    > `Requirement: Invoke endpoint — direct-tool path`.

- [ ] **2.4 Capability advertisement**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Add `customCommands: { enabled: true, paths: [...] }` to
    > `/capabilities`'s `remoteControl` block. Acceptance:
    > capabilities response contains the new block.

## Phase 3 — Client palette integration + ops UX

**Effort:** ~1 day.

- [ ] **3.0 Alignment**
  - **Status:** not-started
  - **Prompt:**
    > Verify Phase 2 `completed`. Confirm both terminal and web
    > clients can poll `/rc/commands` via the
    > `X-Commands-Revision` cheap-poll. Decide poll cadence (every
    > 5 s while focused?) and record.

- [ ] **3.1 Web client palette merge**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Files:** `packages/web-client/src/components/slashPalette.ts`
  - **Prompt:**
    > Fetch `/rc/commands`, merge with built-ins per precedence
    > rule, gray out items with `invocableByYou: false`. On
    > selection of a custom item, post to invoke endpoint. Show
    > shadow indicator for collisions.

- [ ] **3.2 Terminal client palette merge**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Same merge logic inside the existing slash registry. Cache
    > revision string; re-fetch on revision change broadcast (via
    > a new SSE `commands_reloaded` event, or polled every 5 s).

- [ ] **3.3 `qwen rc commands list` CLI**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Subcommand listing all visible commands with source
    > (workspace/user/built-in), scope, and shadowing indicator.
    > Useful when debugging collisions.

- [ ] **3.4 Archive change**
  - **Status:** not-started
  - **Effort:** ~0.25 day
  - **Prompt:**
    > Run `openspec archive add-custom-slash-commands`.

## Effort summary

| Phase     | Description             | Estimate (days) |
| --------- | ----------------------- | --------------- |
| 0         | Foundation              | 0.5             |
| 1         | Loader + storage        | 1.5             |
| 2         | Discovery + execution   | 1.5             |
| 3         | Client palette + ops UX | 1               |
| **Total** |                         | **4.5**         |
