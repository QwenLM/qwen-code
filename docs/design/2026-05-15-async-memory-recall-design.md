# Async Memory Recall — Design Spec

**Date:** 2026-05-15
**Status:** Approved
**Related issues:** #3761, #3759
**Related PRs:** #3814, #3866

---

## Problem

`relevanceSelector.ts` uses `AbortSignal.timeout(1_000)` (introduced by #3866). On first-session cold starts, qwen3.5-flash averages ~908 ms — consistently hitting the 1 s threshold. The outer 2.5 s deadline in `resolveAutoMemoryWithDeadline` means every UserQuery can block for up to 2.5 s even when recall always fails.

Root cause: the main-agent request path `await`s the recall result before sending to the model. Any slowness in the recall side-query directly adds to user-visible latency.

---

## Design

### Core idea

Fire recall on UserQuery and never await it. Consume the result at two opportunistic points — whichever fires first:

1. **UserQuery consume point** — synchronous `settledAt !== null` check just before `turn.run()`. Zero-wait: if already settled, use it; if not, skip.
2. **ToolResult inject point** — same check on every ToolResult turn. Injects memory as a `system-reminder` **appended after** the functionResponse parts in `requestToSend`, giving the model memory context before its next response. (Append, not prepend: the Qwen API requires the functionResponse to immediately follow the model's functionCall — see the existing `hasPendingToolCall` IDE-context skip for the same constraint.)

This matches the pattern used by Claude Code upstream (`startRelevantMemoryPrefetch` / `settledAt` polling in `query.ts`).

---

## Data structures

### New type `MemoryPrefetchHandle` (in `client.ts`)

```typescript
type MemoryPrefetchHandle = {
  promise: Promise<RelevantAutoMemoryPromptResult>;
  /** Set by promise.finally(). null until the promise settles. */
  settledAt: number | null;
  /** True after memory has been injected — prevents double-inject. */
  consumed: boolean;
  controller: AbortController;
};
```

### Field change on `GeminiClient`

| Remove                                                       | Add                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| `pendingRecallAbortController: AbortController \| undefined` | `pendingMemoryPrefetch: MemoryPrefetchHandle \| undefined` |

---

## Changes

### 1. `client.ts` — remove `resolveAutoMemoryWithDeadline`

Delete the function entirely. It is replaced by the `settledAt` flag mechanism.

### 2. `client.ts` — UserQuery fire path

Replace the `resolveAutoMemoryWithDeadline` call with:

```typescript
// Abort any in-flight prefetch from a previous UserQuery before installing
// the new handle (prevents orphan side-queries when the user types again
// before recall settles).
this.pendingMemoryPrefetch?.controller.abort();
this.pendingMemoryPrefetch = undefined;

const controller = new AbortController();
// Bridge the caller's signal into the prefetch controller so a user abort
// (Ctrl-C / Esc) on the parent turn also terminates the recall side-query.
const onParentAbort = () => controller.abort();
if (signal.aborted) {
  controller.abort();
} else {
  signal.addEventListener('abort', onParentAbort, { once: true });
}

const promise = this.config
  .getMemoryManager()
  .recall(projectRoot, partToString(request), {
    config: this.config,
    excludedFilePaths: this.surfacedRelevantAutoMemoryPaths,
    abortSignal: controller.signal,
  })
  .catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      debugLogger.warn('Managed auto-memory recall prefetch failed.', error);
    }
    return EMPTY_RELEVANT_AUTO_MEMORY_RESULT;
  });

const handle: MemoryPrefetchHandle = {
  promise,
  settledAt: null,
  consumed: false,
  controller,
};
void promise.finally(() => {
  handle.settledAt = Date.now();
  signal.removeEventListener('abort', onParentAbort);
});
this.pendingMemoryPrefetch = handle;
// no await — continue immediately
```

### 3. `client.ts` — UserQuery consume point (replaces `await relevantAutoMemoryPromise`)

```typescript
const prefetchHandle = this.pendingMemoryPrefetch;
if (
  prefetchHandle &&
  prefetchHandle.settledAt !== null &&
  !prefetchHandle.consumed
) {
  prefetchHandle.consumed = true;
  this.pendingMemoryPrefetch = undefined;
  const result = await prefetchHandle.promise; // already settled, returns immediately
  if (result.prompt) {
    // unshift, not push: keep memory at the front of systemReminders so
    // it leads the system-reminder block on UserQuery turns. (ToolResult
    // turns instead append to requestToSend to preserve functionCall /
    // functionResponse pairing — see below.)
    systemReminders.unshift(result.prompt);
    for (const doc of result.selectedDocs) {
      this.surfacedRelevantAutoMemoryPaths.add(doc.filePath);
    }
  }
}
```

### 4. `client.ts` — ToolResult inject point (new)

After `requestToSend` is assembled, before `turn.run()`, add:

```typescript
if (messageType === SendMessageType.ToolResult) {
  const prefetchHandle = this.pendingMemoryPrefetch;
  if (
    prefetchHandle &&
    prefetchHandle.settledAt !== null &&
    !prefetchHandle.consumed
  ) {
    prefetchHandle.consumed = true;
    this.pendingMemoryPrefetch = undefined;
    const result = await prefetchHandle.promise;
    if (result.prompt) {
      // Append (not prepend) so functionResponse parts stay first
      // and the model's functionCall/functionResponse pairing
      // isn't broken on the native Gemini path.
      requestToSend = [...requestToSend, result.prompt];
      for (const doc of result.selectedDocs) {
        this.surfacedRelevantAutoMemoryPaths.add(doc.filePath);
      }
    }
  }
}
```

### 5. `client.ts` — cleanup paths

The handle is released by two distinct mechanisms:

**5 abort-and-clear sites** (the prefetch is still pending, abort the controller before dropping the reference). Replace `pendingRecallAbortController?.abort()` + `= undefined` with:

```typescript
this.pendingMemoryPrefetch?.controller.abort();
this.pendingMemoryPrefetch = undefined;
```

Sites: `resetChat()`, `MaxSessionTurns` early-return, `boundedTurns=0` early-return, `SessionTokenLimitExceeded` early-return, Arena control-signal early-return. The fire path itself also performs this abort-then-replace when a new UserQuery arrives while the previous prefetch is still in flight.

**2 clear-only sites** (the prefetch has already settled and we're consuming it — no controller to abort, just drop the reference):

```typescript
prefetchHandle.consumed = true;
this.pendingMemoryPrefetch = undefined;
```

Sites: UserQuery consume point, ToolResult inject point.

### 6. `relevanceSelector.ts` — remove `AbortSignal.timeout(1_000)`

Remove the combined `AbortSignal.any([AbortSignal.timeout(1_000), callerAbortSignal])` and pass `callerAbortSignal` directly.

---

## Behaviour comparison

| Scenario                                     | Before                         | After                                                  |
| -------------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| recall completes before model prep           | inject on UserQuery, ~0 wait   | inject on UserQuery, ~0 wait                           |
| recall slow (cold start)                     | block up to 2.5 s              | skip UserQuery, inject on first ToolResult             |
| recall times out (1 s)                       | abort, empty result, no memory | no hard timeout; inject whenever settled               |
| no tool calls, recall slow                   | block up to 2.5 s, then skip   | skip UserQuery, no ToolResult opportunity — miss       |
| user sends 2nd message before recall settles | 2nd recall races 1st handle    | 1st handle aborted when 2nd UserQuery fires new handle |

---

## Out of scope

- Changing the memory injection format from `system-reminder` to `tool-result` attachment (CC style)
- Per-session byte budget skip gate
- Single-word prompt skip gate
