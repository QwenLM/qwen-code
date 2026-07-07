# Prompt Queue Backpressure E2E Test Plan

## Scope

Validate per-session prompt admission backpressure for `qwen serve`, REST clients, ACP HTTP clients, and the TypeScript SDK.

## Baseline

1. Start `qwen serve` with defaults.
2. Create a session.
3. Send one prompt.
4. Expected: prompt is accepted and the session emits normal turn events.

## Full Queue

1. Start `qwen serve` with defaults.
2. Create a session.
3. Hold one prompt active and enqueue four more prompts for the same session.
4. Send the sixth prompt.
5. Expected: the sixth request returns HTTP `503`, `Retry-After: 5`, and `code: "prompt_queue_full"`. The body includes `sessionId`, `limit: 5`, and `pendingCount: 5`. The response does not include `promptId`.

## Release Then Recover

1. Fill the default five pending prompt slots.
2. Let the active prompt complete or fail.
3. Send another prompt.
4. Expected: the new prompt is accepted after the previous slot is released.

## ACP HTTP

1. Send `session/prompt` through `/acp` while the same session has five pending prompts.
2. Expected: JSON-RPC returns stable error data with `errorKind: "prompt_queue_full"`, `limit`, `pendingCount`, and `sessionId`.

## SDK Local Guard

1. Construct `DaemonClient` with `maxPendingPromptsPerSession: 1`.
2. Use a daemon or fetch mock that accepts the first prompt with `202` and keeps its SSE stream pending.
3. Call `prompt()` again for the same session.
4. Expected: the SDK throws `DaemonPendingPromptLimitError` and does not issue the second fetch.

## Disabled Cap

1. Start `qwen serve --max-pending-prompts-per-session 0`.
2. Create a session.
3. Enqueue more than five prompts for the same session.
4. Expected: admission is not rejected by the prompt queue cap. `/capabilities.limits.maxPendingPromptsPerSession` is `null`.

## Verification Commands

```bash
cd packages/acp-bridge && npx vitest run src/bridge.test.ts
cd packages/cli && npx vitest run src/serve/server.test.ts src/serve/acpHttp/transport.test.ts
cd packages/sdk-typescript && npx vitest run test/unit/DaemonClient.test.ts test/unit/DaemonSessionClient.test.ts
npm run build && npm run typecheck
```
