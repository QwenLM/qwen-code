# Design: streaming inactivity timeout for the OpenAI-compatible pipeline

- **Date:** 2026-06-24
- **Component:** `packages/core` — `openaiContentGenerator/pipeline.ts`
- **Status:** Approved design (audited 7 rounds), ready for TDD
- **Scope:** measures #1 + #2 only (watchdog + abort + synthetic ETIMEDOUT). Out
  of scope: terminal SSE event to the UI (#9), non-streaming path.

## Problem

A DataAgent incident ("一直运行不返回") root-caused to the model gateway
(Aliyun PrivateLink → DashScope/Bailian `compatible-mode`, qwen3.7-max) accepting
a request (HTTP 200) but then **streaming nothing** — the SSE body stayed open
and silent for ~595s with no `finish_reason`.

qwen-code had no effective recovery:

- The OpenAI client `timeout` (`DEFAULT_TIMEOUT = 120_000`) is **request-level**
  (connect + getting the response object). Once
  `chat.completions.create({stream:true})` returns the stream after a fast 200,
  inter-chunk inactivity during `for await` is **unbounded**.
- The only inactivity timer (`STREAM_IDLE_TIMEOUT_MS = 5min` in
  `loggingContentGenerator.ts`) is **telemetry-only** — it closes the OTel span
  so it does not leak, it does **not** abort the request or throw.

So a 200-then-silent stream hangs until the connection dies or the 30-minute
interaction TTL, and the content-retry loop (`NO_FINISH_REASON`) never engages
because the stream never completes.

## Key insight

The transport layer _should_ have produced an `ETIMEDOUT` on an idle socket, but
didn't (the socket stayed open with no data). The fix is to **add the inactivity
timeout the transport lacks, and synthesize the `ETIMEDOUT` it failed to emit** —
making a silent stall indistinguishable from a real read timeout, which the
existing retry/backoff/fallback stack already handles.

## Verified mechanics (audit)

1. `pipeline.executeStream` creates `perRequestAc = createChildAbortController(parentSignal)`
   and passes `perRequestAc.signal` to the SDK. This is the controller that
   actually cancels the fetch. The logging wrapper one layer up only has the
   read-only signal — so the watchdog must live in the **pipeline**.
2. `classifyRetryError` checks `isRetryAbortError` (isAbortError ||
   name==='CanceledError') **first** → any abort = `{kind:'abort',
diagnosis:'fail-fast'}` = **not retryable**. So the watchdog must NOT surface a
   raw AbortError.
3. `getTransportCode(err)` reads `err.code` / `err.cause.code`; a plain
   `Object.assign(new Error(...), {code:'ETIMEDOUT'})` →
   `{kind:'transport', diagnosis:'retryable', transportCode:'ETIMEDOUT'}`.
4. geminiChat's stream-transport-retry fires when
   `classification.kind==='transport' && transportCode ∈ {ECONNRESET, ETIMEDOUT}
&& !streamYieldedChunk` (`TRANSPORT_STREAM_RETRY_CONFIG.maxRetries = 2`). So a
   **first-byte / zero-chunk** timeout (exactly the incident) auto-retries; a
   stall **after** chunks surfaces as a transport error (no retry — acceptable).

## Decisions (locked)

| Decision                   | Choice                                                           |
| -------------------------- | ---------------------------------------------------------------- |
| Timeout value & config     | New `contentGenerator.streamIdleTimeoutMs`, default **120000ms** |
| On timeout                 | **Abort + synthetic ETIMEDOUT** (reuse transport-retry)          |
| PR scope                   | **#1 + #2 only** (terminal SSE event is a separate PR)           |
| 5-min telemetry idle timer | **Keep as backstop** (untouched)                                 |

## Design

All changes in `packages/core/src/core/openaiContentGenerator/`.

### 1. Config

Add `streamIdleTimeoutMs?: number` to `ContentGeneratorConfig`
(`contentGenerator.ts`). Pipeline resolves it as
`this.contentGeneratorConfig.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS`
(`120_000`). A value `<= 0` disables the watchdog (passthrough).

### 2. Inactivity-timeout generator (`pipeline.ts`)

A private async generator wraps the **raw SDK chunk stream** before
`processStreamWithLogging`:

```ts
async function* withStreamInactivityTimeout(
  source: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  idleMs: number,
  abortRequest: () => void, // aborts perRequestAc → frees the socket
  parentSignal: AbortSignal | undefined,
): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
  const it = source[Symbol.asyncIterator]();
  const streamStartedAt = Date.now();
  let chunksReceived = 0;
  try {
    while (true) {
      const nextPromise = it.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // User cancel takes precedence over our timeout relabel.
          // Use a plain Error (NOT DOMException): error redaction clones via
          // Object.create(getPrototypeOf(err)), which corrupts a DOMException
          // (its `name` is an internal-slot getter the clone lacks). `name ===
          // 'AbortError'` satisfies isAbortError.
          if (parentSignal?.aborted) {
            const abortErr = new Error('Aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          } else {
            abortRequest(); // abort perRequestAc → fetch tears down
            reject(
              new StreamInactivityTimeoutError(
                idleMs,
                chunksReceived,
                Date.now() - streamStartedAt,
              ),
            ); // code: 'ETIMEDOUT'
          }
        }, idleMs);
        timer.unref?.();
      });
      let result: IteratorResult<OpenAI.Chat.ChatCompletionChunk>;
      try {
        result = await Promise.race([nextPromise, timeout]);
      } catch (err) {
        // After we abort, the orphaned nextPromise rejects with AbortError;
        // swallow it so it is not an unhandled rejection.
        void Promise.resolve(nextPromise).catch(() => {});
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (result.done) return;
      chunksReceived += 1;
      yield result.value; // a chunk arrived → next loop starts a fresh timer
    }
  } finally {
    abortRequest();
    try {
      await it.return?.();
    } catch {
      // The abort above is the cleanup that matters; ignore return failures.
    }
  }
}
```

The timer **resets on every raw chunk** (including thinking/reasoning deltas), so
a long-thinking model that streams reasoning is never wrongly aborted; only true
silence (no chunk for `idleMs`) trips it.

```ts
class StreamInactivityTimeoutError extends Error {
  readonly code = 'ETIMEDOUT' as const;

  constructor(
    readonly idleMs: number,
    readonly chunksReceived: number,
    readonly streamLifetimeMs: number,
  ) {
    super(`No stream activity for ${idleMs}ms (inactivity timeout)`);
    this.name = 'StreamInactivityTimeoutError';
  }
}
```

### 3. Wiring in `executeStream`

After Stage 1 creates `stream`, wrap it before Stage 2. Streaming requests
always use a per-request controller so the watchdog can abort the SDK request
even when the caller did not provide a parent signal:

```ts
const idleMs =
  this.contentGeneratorConfig.streamIdleTimeoutMs ??
  DEFAULT_STREAM_IDLE_TIMEOUT_MS;
const guarded =
  idleMs > 0
    ? withStreamInactivityTimeout(
        stream,
        idleMs,
        () => perRequestAc.abort(),
        parentSignal,
      )
    : stream;
// ...processStreamWithLogging(guarded, context, request) as today,
// keeping the existing drainThenCleanup wrapper.
```

## Behavior after the change

- 200-then-silent (zero chunks) → after `idleMs`: abort fetch + throw ETIMEDOUT →
  `{transport, retryable}` → transport-retry (×2, `!streamYieldedChunk`) →
  auto-recovers; on exhaustion surfaces as a transport error.
- Stall after some chunks → ETIMEDOUT thrown; `streamYieldedChunk` is true so it
  is **not** transport-retried — surfaces as an error (no risky mid-generation
  replay).
- Active stream (incl. thinking) → timer resets each chunk; never trips.
- Parent/user abort → AbortError propagated unchanged (fail-fast user cancel).
- The 5-min telemetry idle timer becomes a backstop that the ~120s watchdog
  pre-empts; left untouched.

## Out of scope

- Terminal `turn_error` SSE on retry exhaustion (#9) — separate PR.
- Non-streaming `execute()` — already bounded by the 120s request-level timeout.

## Testing (TDD)

In `pipeline.test.ts`, with `vi.useFakeTimers()` and a controllable mock stream
(yields N chunks then `next()` returns a never-resolving promise):

1. **Zero-chunk stall** → consuming the stream rejects with an error whose
   `code === 'ETIMEDOUT'` after advancing `idleMs`.
2. **Stall after chunks** → the yielded chunks come through, then rejects with
   `code === 'ETIMEDOUT'`.
3. **Active stream resets the timer** → chunks arriving within `idleMs` never
   trip the watchdog; the stream completes normally.
4. **Parent abort precedence** → with the parent signal aborted at timeout, the
   error is an AbortError, not ETIMEDOUT.
5. **Disabled when `streamIdleTimeoutMs <= 0`** → a hanging stream does not throw
   on timer advance (passthrough).
6. **Custom `streamIdleTimeoutMs`** → the configured value is honored (trips at
   the configured ms, not the default).
7. **Orphaned SDK `next()` rejection** → after the watchdog aborts the request,
   a later SDK `AbortError` rejection from the pending `next()` is swallowed and
   does not emit `unhandledRejection`.
