# User-Level Language Sync for the Daemon (`POST /language`)

Date: 2026-08-29
Upstream issue: https://github.com/QwenLM/qwen-code/issues/10234

## Background

Daemon-backed hosts (DAC welcome page, Web Shell before session open) need to
synchronize the user-level language preference **before any session exists**.
The daemon currently exposes language synchronization only through
`POST /session/:id/language`, which is wrapped in `withOwnerMutableSession` and
therefore requires an existing owned, mutable session. A fabricated session ID
is rejected.

The session requirement is a poor fit because most of the operation is already
user-level or process-global (see `sessionLanguage` in
`packages/cli/src/acp-integration/acpAgent.ts`):

- `setLanguageAsync()` switches the process UI language;
- `general.language` / `general.outputLanguage` persist at `SettingScope.User`;
- the global `~/.qwen/output-language.md` is written when no project-bound file
  is involved;
- when output-language sync is requested, **all** active sessions are
  refreshed, not only the one named in the URL.

Two adjacent facts close the remaining escape hatches:

- `initializeLlmOutputLanguage()` intentionally preserves an existing valid
  `output-language.md`, so creating a new session does not repair a stale
  output language;
- `POST /workspace/settings` excludes `general.outputLanguage` as TUI-only
  (`TUI_ONLY_SETTINGS` in `workspace-settings.ts`).

## Goals

- A daemon-level mutation that performs user-level language synchronization and
  succeeds with **zero sessions and zero workspaces**.
- Best-effort refresh of all active sessions across all trusted runtimes when
  `syncOutputLanguage` is true.
- Capability advertisement so hosts can feature-detect and degrade gracefully
  on older daemons.

## Non-goals

- No change to `POST /session/:id/language` (kept for backward compatibility
  and for project-bound output-language semantics).
- No change to `initializeLlmOutputLanguage()` preservation behavior.
- `POST /workspace/settings` keeps excluding `general.outputLanguage`:
  persistence is not synchronization (no live i18n switch, no session refresh).

## Route ownership classification

Per the daemon-route ownership taxonomy, the new route is **process-global**:

- It mutates user-global state (`~/.qwen/settings.json`,
  `~/.qwen/output-language.md`) and the daemon process i18n.
- It does not belong to a workspace runtime or a live-session owner; it must
  not consume a workspace selector or a session ID.
- A workspace-qualified spelling (`/workspaces/:workspace/language`) was
  rejected: it would disguise a user-global side effect as a workspace
  resource, and in multi-workspace mode it would silently skip other
  workspaces' runtimes.

## API contract

```http
POST /language
Authorization: Bearer <token>
x-qwen-client-id: <clientId>        # optional, event attribution only
Content-Type: application/json

{ "language": "zh", "syncOutputLanguage": true }
```

- `language`: validated against the same `LANGUAGE_CODES` whitelist as the
  session route (`400 invalid_language` on mismatch).
- `syncOutputLanguage`: optional boolean (`400 invalid_sync_flag`).
- Auth: non-strict `mutate()` gate — same bar as the sibling session route.
  Language switching is low-severity; a strict gate would lock out the local
  no-token developer mode that welcome-page hosts rely on. The clientId header
  is validated against the union of all registered runtimes' known clients
  (`parseAndValidateWorkspaceClientId`) and used only for event attribution.

Response (mirrors `SetSessionLanguageResult`, with a refresh summary):

```json
{
  "language": "zh",
  "outputLanguage": "Chinese",
  "refresh": { "runtimes": 2, "sessions": 5, "failed": 0 }
}
```

Zero sessions / zero runtimes is a **200** with a zeroed `refresh` summary —
this is the core acceptance criterion.

Capability: `/capabilities` returns a `features` string array; hosts detect the
route with `features.includes('user_language_sync')`.

## Execution flow

1. Mutation gate, body validation, clientId validation.
2. In the **daemon process** (single writer, no cross-process settings race):
   1. persist `general.language` at user scope;
   2. `resolveOutputLanguageOrPreserveAuto()` and write the global
      `output-language.md`, then persist `general.outputLanguage` at user
      scope (when `syncOutputLanguage`);
   3. any persistence failure → `500 persist_error`; the failing step and
      everything after it is skipped (earlier applied steps are not rolled
      back);
   4. `setLanguageAsync()` for the daemon process itself (best-effort);
   5. publish `language_changed` workspace event with `originatorClientId`.
3. Fan out (`Promise.allSettled`) to every trusted runtime with a live ACP
   channel: new ext-method `qwen/control/user/language` (sessionless). The
   runtime switches its own process i18n, reloads user-scope settings from
   disk (`reloadScopeFromDisk`), and, when `syncOutputLanguage` is true,
   refreshes each of its sessions (`refreshHierarchicalMemory` +
   `refreshSystemInstruction`).

### Key decisions

- **Persist once, in the daemon process.** The session route lets the runtime
  child process write user-scope settings; fanning that out to N workspace
  runtimes would mean N concurrent whole-file rewrites of `settings.json`. The
  daemon persists once; runtimes only call `reloadScopeFromDisk(User)` to pick
  up the new values — no writes from any child process.
- **Runtimes without a live ACP channel are skipped, not failed.** They have
  no sessions to refresh and will read the updated files when they next spawn.
  This also covers "workspaces registered but zero sessions".
- **Project-bound output-language files are untouched.** The user-level route
  writes only the global file. On refresh, a session re-reads its registered
  path, so a workspace `.qwen/output-language.md` continues to win — project
  override semantics fall out naturally. This differs intentionally from the
  session route, which writes the new value into every session's project file;
  the protocol doc must state this difference.
- **`mutate()` stays non-strict** for parity with `POST /session/:id/language`
  and to keep loopback no-token developer mode working.

## Failure matrix

| Scenario                       | Behavior                                                                |
| ------------------------------ | ----------------------------------------------------------------------- |
| Zero sessions, zero workspaces | 200, refresh summary all zeros                                          |
| Persistence failure            | 500 `persist_error`; later steps skipped, earlier steps not rolled back |
| Partial fan-out failure        | 200, `refresh.failed > 0`, warn-logged                                  |
| Runtime without live channel   | Skipped, not counted as failed                                          |
| Open loopback without token    | Allowed (non-strict gate, sibling parity)                               |

## Compatibility

The change is purely additive (new route + new ext-method + new SDK method +
new capability flag). Older daemons 404 the route; hosts detect
`user_language_sync` via `/capabilities` and degrade to the previous behavior
(persist UI language via `POST /workspace/settings`, which already accepts
`general.language` at user scope, and accept that output language only applies
to future sessions).

## Change surface

| Layer      | Location                                               | Change                                                                                      |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Protocol   | `packages/acp-bridge/src/status.ts`                    | `SERVE_CONTROL_EXT_METHODS.userLanguage`                                                    |
| Bridge     | `packages/acp-bridge/src/bridge.ts`, `bridgeTypes.ts`  | `setUserLanguage()` over the runtime control channel                                        |
| Runtime    | `packages/cli/src/acp-integration/acpAgent.ts`         | Sessionless `userLanguage` case                                                             |
| Route      | `packages/cli/src/serve/routes/user-language.ts` (new) | `POST /language`; telemetry catalog entry                                                   |
| Capability | `packages/cli/src/serve/capabilities.ts`               | registry entry + conditional predicate                                                      |
| SDK        | `packages/sdk-typescript/src/daemon/`                  | `setUserLanguage()` + `SetUserLanguageResult`                                               |
| Docs       | `docs/developers/qwen-serve-protocol.md`               | Contract, ownership class, semantic difference vs session route                             |
| Tests      | server/acpAgent/bridge/DaemonClient test files         | Zero-session 200, 400s, persist-failure purity, partial fan-out, project override untouched |
