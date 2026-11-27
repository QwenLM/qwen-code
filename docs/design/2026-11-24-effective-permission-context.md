# Effective permission context

[English](2026-11-24-effective-permission-context.md) | [简体中文](2026-11-24-effective-permission-context.zh-CN.md)

## Problem and scope

A session can run in `default` while a settings file still contains `auto`. Reading that file or observing a successful tool call cannot establish the active approval mode or whether a human approved the call. Main-session requests need effective runtime context before the model decides which tools to call.

This change covers main CLI, TUI, stream-json and ACP requests, plus forked chats that inherit the context. It does not change permission enforcement, approval UI, command execution, retries, or tool-call limits. Context delivery cannot guarantee model compliance with a request to ask first or execute only once.

## Codex reference and cache behavior

Codex compares effective permission snapshots derived from the execution step, renders no update when the state is unchanged, and appends changed context to conversation history. Its permission updates are developer messages. See [permission state comparison](https://github.com/openai/codex/blob/9b2ef38f548f120a092a2870da2883e0c8300116/codex-rs/core/src/context/world_state/permissions.rs) and [step world-state recording](https://github.com/openai/codex/blob/9b2ef38f548f120a092a2870da2883e0c8300116/codex-rs/core/src/session/mod.rs).

Qwen Code follows that snapshot-and-append approach using its existing user-message system-reminder convention. The permission update does not rewrite the system prompt or previous permission snapshots. With otherwise unchanged request construction, the preceding provider messages remain an exact prefix after a mode change. Repeated requests in the same mode add no permission text.

This preserves the cacheable prefix; it does not guarantee a provider cache hit. The initial snapshot and subsequent changes add tokens. Compaction, history replacement, tool changes, provider routing and provider cache policy can still affect caching.

## Runtime snapshot lifecycle

Main chats opt in at creation, including resume, clear and compaction rebuilds. Before a newly prepared model request, the chat reads `Config.getApprovalMode()`, compares it with the latest marked snapshot in the surviving history, and appends only a missing or changed snapshot. Text equality also detects a truncated or outdated snapshot. User-quoted text without the internal metadata cannot suppress the runtime context.

The snapshot names all five modes and explains their limits. In particular, `default` can allow read-only or explicitly allowed actions without a prompt; `auto` can use automatic review and still deny an action or require manual approval. The text tells the model to use the runtime state instead of inferring a mode from settings or a successful call. No settings contents, credentials or rule lists are included.

Append to the current user/tool-result entry without mutating shared inherited entries. Preserve leading tool responses, the order of successive snapshots, and the trailing UserPromptSubmit receipt. Keep permission and memory snapshot insertion and recording order identical so restoration reproduces the same request prefix. Existing request projection places reminders consistently before user text.

Chats inheriting a marked snapshot adopt the same lifecycle. A child keeps its parent's prefix and appends its own effective mode if different. Unrelated chats that do not opt in and inherit no snapshot remain unchanged.

## Persistence and accounting

Record each durable update as a `permission_context_snapshot` system transcript record. Normal replay, selective resume, managed-session migration and turn deletion handle it alongside existing context records. Restoring an unchanged snapshot avoids redundant injection. If compaction or replacement removes it, the next fresh request appends the current state.

Prompt estimation previews a pending snapshot without recording it and includes it in request sizing. Newly appended context is charged once when the provider omits usage. Temporary recovery projections do not mutate history or write records.

Persisted prepared-request retries keep their exact saved request. They do not rewrite permission context mid-replay; the next newly prepared request compares the live mode again. Runtime tool checks remain authoritative even when a saved request contains an earlier snapshot.

## Validation and acceptance

- Capture requests in all five modes, including persisted `auto` overridden by live `default`.
- Exercise both ACP agent loops through `default → default → auto → auto-edit → yolo → plan → default`.
- Assert the system prompt stays identical, each previous complete request message array is an exact prefix of the next, and the repeated mode adds no snapshot.
- Verify inherited parent/child mode differences preserve the parent's prefix and append the child's mode.
- Cover history replacement, compaction, transcript round trips, selective restoration, managed migration, turn deletion, request-only recovery and prompt accounting.
- Run focused tests, build, typecheck and deterministic provider-capture checks. No live inference is needed to verify delivery and prefix preservation; actual cache-hit rates and model compliance are outside this verification.
