/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { Kind, CONCURRENCY_SAFE_KINDS } from '../tools/tools.js';
import { ToolNames, ToolNamesMigration } from '../tools/tool-names.js';
import { isShellCommandReadOnly } from '../utils/shellReadOnlyChecker.js';
import { stripShellWrapper } from '../utils/shell-utils.js';
import {
  executeToolCall,
  type ExecuteToolCallOptions,
} from './nonInteractiveToolExecutor.js';
import {
  StreamingToolExecutor,
  type StreamingToolExecutorDiscardReason,
} from './streamingToolExecutor.js';
import type { ToolCallRequestInfo, ToolCallResponseInfo } from './turn.js';

/**
 * Phase 3 of #4387.
 *
 * Coordinates early dispatch of stream-surfaced tool calls. Wraps a
 * {@link StreamingToolExecutor} (the buffer / lifecycle source-of-truth)
 * with a per-batch `AbortController` and a Map of in-flight dispatches.
 *
 * Responsibilities:
 *   - Classify each accepted request via {@link isEarlyDispatchSafe} and
 *     fire `executeToolCall` for the safe ones the moment they land.
 *   - Deposit results into the executor as they settle, so the
 *     post-stream consumer can drain the same buffered view.
 *   - Cancel every in-flight dispatch synchronously when the executor's
 *     buffer is wiped (mid-stream retry, abort, unauthorized,
 *     stream-error) — Turn fires `executor.reset()` / `executor.discard()`,
 *     which routes through {@link StreamingToolExecutor.addCancellationListener}
 *     to this dispatcher's `AbortController`. After abort, late completions
 *     are dropped on the floor (matching the executor's stale-callback
 *     contract on {@link StreamingToolExecutor.recordResult}).
 *
 * Result submission still buffers — `functionResponse` parts must reach
 * the API only after the matching model `functionCall` is in history. The
 * dispatcher does not touch chat history; it just gets the work started
 * earlier and lets the consumer drain results in batch order.
 *
 * **Initial scope (Phase 3):** read / search / fetch kinds, plus shell
 * commands that the synchronous read-only checker recognises. AGENT is
 * deliberately excluded pending separate review (RFC #4387 §3.4 “possibly
 * agent calls, but only after separate review”). Tools requiring a
 * confirmation step (Edit, Delete, Move, Execute on non-read-only shell)
 * stay on the post-stream path.
 *
 * Single-Turn ownership matches the underlying executor — sharing a
 * dispatcher across concurrent Turns would let one Turn's abort cancel
 * the other's in-flight tools.
 */
/**
 * Resolve `ExecuteToolCallOptions` for a specific request when it is
 * dispatched early. Lets the consumer wire its per-tool
 * `outputUpdateHandler` / `onToolCallsUpdate` callbacks (progress
 * surfacing, STREAM_JSON tool-call updates) so an early-dispatched tool
 * gets the same UX side-effects as the post-stream scheduling path.
 *
 * Without a factory, early dispatches run with empty options and any
 * `canUpdateOutput: true` tool's progress callbacks fire into a no-op
 * — a long-running early-dispatched Fetch would look like a silent
 * stall to the SDK consumer.
 */
export type StreamingToolDispatcherOptionsFor = (
  request: ToolCallRequestInfo,
) => ExecuteToolCallOptions;

export class StreamingToolDispatcher {
  private readonly executor: StreamingToolExecutor;
  private readonly inFlight = new Map<
    string,
    Promise<ToolCallResponseInfo | undefined>
  >();
  private abortController: AbortController;
  private readonly unsubscribe: () => void;
  private readonly parentSignal: AbortSignal;
  private readonly parentAbortHandler: () => void;
  private readonly optionsFor: StreamingToolDispatcherOptionsFor | undefined;
  private disposed = false;

  /**
   * @param config         Tool registry + execution config.
   * @param parentSignal   Parent abort (turn / session signal). Child
   *                       AbortControllers are derived from this so a
   *                       parent abort cancels every in-flight dispatch.
   * @param executor       Optional externally-owned buffer. **Required**
   *                       when the same executor is being handed to
   *                       Turn via `SendMessageOptions.streamingToolExecutor`
   *                       — otherwise the listener-driven orphan
   *                       prevention is silently disconnected.
   * @param optionsFor     Optional per-request {@link ExecuteToolCallOptions}
   *                       factory. Use this to wire progress / update
   *                       callbacks for early-dispatched tools — see
   *                       {@link StreamingToolDispatcherOptionsFor}.
   */
  constructor(
    private readonly config: Config,
    parentSignal: AbortSignal,
    executor?: StreamingToolExecutor,
    optionsFor?: StreamingToolDispatcherOptionsFor,
  ) {
    this.executor = executor ?? new StreamingToolExecutor();
    this.parentSignal = parentSignal;
    this.optionsFor = optionsFor;
    this.abortController = this.makeChildAbort();
    this.parentAbortHandler = () => this.abortController.abort();
    if (parentSignal.aborted) {
      this.abortController.abort();
    } else {
      parentSignal.addEventListener('abort', this.parentAbortHandler, {
        once: true,
      });
    }

    // React to Turn-internal `executor.reset('retry')` /
    // `executor.discard('...')` calls so in-flight dispatches don't outlive
    // the buffer that owns their result slot. Using the executor's
    // cancellation hook (rather than wrapping every Turn lifecycle event in
    // the consumer) keeps the orphan-prevention guarantee local to this
    // class — even a future caller that forgets to thread retries through
    // the dispatcher still won't leak orphan tool runs.
    //
    // CRITICAL: this only works when the executor passed in here is the
    // SAME instance Turn was constructed with (via
    // `SendMessageOptions.streamingToolExecutor`). With separate
    // instances Turn's lifecycle calls land on its own executor and
    // never reach this listener.
    this.unsubscribe = this.executor.addCancellationListener(() => {
      this.cancelInFlight();
    });
  }

  /**
   * The underlying buffer / lifecycle source. Two equivalent ways to
   * share with Turn:
   *
   *   - **Preferred** (current production wiring): construct the
   *     executor first, hand it to BOTH the dispatcher constructor
   *     and `SendMessageOptions.streamingToolExecutor`. Symmetric
   *     and obvious at the call site.
   *
   *   - Alternative: construct the dispatcher first (which creates
   *     an internal executor), then read it via `getExecutor()` and
   *     pass that to `SendMessageOptions.streamingToolExecutor`.
   *     Same result.
   *
   * What MUST NOT happen: omit the injection. Without sharing, Turn's
   * `discard()` / `reset()` lands on a different instance and the
   * orphan-prevention listener silently never fires.
   */
  getExecutor(): StreamingToolExecutor {
    return this.executor;
  }

  /**
   * Record the request and, if it classifies as safe, kick off its
   * dispatch immediately. Idempotent on duplicate callIds — re-deliveries
   * from the provider hit the executor's existing accept-once guard and
   * this method's in-flight map check.
   *
   * The dispatch promise is stored in `inFlight` so {@link getEarlyResult}
   * can be awaited by the post-stream consumer. The promise resolves to
   * `undefined` (rather than rejecting) on abort — distinguishing
   * “dispatch dropped because the buffer was wiped” from “tool errored”.
   * A tool error is still a {@link ToolCallResponseInfo} with `error` set
   * and resolves normally so the consumer can submit it as the matching
   * functionResponse.
   */
  accept(request: ToolCallRequestInfo): void {
    if (this.disposed) return;
    if (this.executor.isClosed() || this.executor.isDiscarded()) return;
    // Forward to the executor — `accept()` there is idempotent on
    // duplicate callIds. Note when the consumer ALSO injected this
    // executor into Turn, Turn itself called `executor.accept()` first
    // (see turn.ts:471). Both paths converge on the same one-slot-per-
    // callId guarantee.
    this.executor.accept(request);
    // Dispatch-dedupe lives on `inFlight` rather than the executor's
    // accepted set: post-`reset()` (mid-stream retry) the executor's
    // acceptedIds are cleared AND our cancellation listener has already
    // cleared `inFlight`, so a retried-with-same-callId request
    // correctly dispatches fresh. Using `inFlight.has()` keeps the
    // dispatch dedupe internal to the dispatcher and O(1).
    if (this.inFlight.has(request.callId)) return;
    if (!isEarlyDispatchSafe(this.config, request)) return;
    this.dispatch(request);
  }

  /**
   * Promise for the result of the early dispatch of `callId`, or
   * `undefined` if no early dispatch was kicked off (request was
   * classified unsafe or never accepted). The promise itself may resolve
   * to `undefined` if the dispatch was aborted before its tool finished —
   * the consumer should treat that case as "fall back to the post-stream
   * path", which will then synthesise the proper functionResponse via the
   * normal scheduling code.
   */
  getEarlyResult(
    callId: string,
  ): Promise<ToolCallResponseInfo | undefined> | undefined {
    return this.inFlight.get(callId);
  }

  /** True iff an early dispatch was kicked off for this callId. */
  hasEarlyDispatch(callId: string): boolean {
    return this.inFlight.has(callId);
  }

  /**
   * Wait for every in-flight dispatch to settle, then return the
   * executor's snapshot of completed results in accept order. Rejects only
   * if the executor was discarded (terminal) before completion — same
   * contract as {@link StreamingToolExecutor.getRemainingResults}.
   *
   * Safe to call after `close()` / `discard()` on the underlying executor;
   * aborted dispatches resolve to `undefined` here and are simply absent
   * from the executor's completed-results view.
   */
  async drainInFlight(): Promise<ToolCallResponseInfo[]> {
    if (this.inFlight.size > 0) {
      await Promise.allSettled(this.inFlight.values());
    }
    return this.executor.getCompletedResults();
  }

  /**
   * Forwards to {@link StreamingToolExecutor.close}. Future accepts become
   * no-ops; in-flight dispatches keep running and can still deposit
   * results — close is not an abort.
   */
  close(): void {
    this.executor.close();
  }

  /**
   * Terminal abort. Cancels in-flight dispatch via the child
   * `AbortController` and forwards to {@link StreamingToolExecutor.discard}.
   * After this, `accept()` is a no-op and `getEarlyResult()` returns
   * `undefined` for fresh callIds (existing in-flight promises still
   * resolve, but to `undefined`).
   */
  discard(reason?: StreamingToolExecutorDiscardReason): void {
    // The cancellation listener will fire `cancelInFlight()` re-entrantly
    // from inside `executor.discard()`. We deliberately delegate rather
    // than abort first so the listener's view of "executor is discarded"
    // matches the dispatcher's view of "in-flight is cancelled" —
    // otherwise a listener could observe a half-state.
    this.executor.discard(reason);
  }

  /**
   * Non-terminal wipe — same semantics as {@link discard} but leaves the
   * executor Open for the next attempt's accepts. Used on mid-stream
   * retry. The next batch gets a fresh `AbortController`; dispatches from
   * the previous attempt cannot record into the new batch's slots
   * (in-flight promises were already detached by `cancelInFlight()`).
   */
  reset(reason?: StreamingToolExecutorDiscardReason): void {
    this.executor.reset(reason);
  }

  /**
   * Detach from the underlying executor and the parent signal. Idempotent.
   * Does NOT abort in-flight dispatches — call {@link discard} first if
   * you want them cancelled. Intended for the consumer's `finally` block
   * once the dispatcher is no longer needed (post-stream cleanup).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.parentSignal.removeEventListener('abort', this.parentAbortHandler);
  }

  /**
   * Convenience for the consumer's `finally` block: cancel any in-flight
   * dispatch + {@link dispose}. Idempotent (via the `disposed` guard).
   * Without this pattern, an exception escaping the consumer's
   * processing loop can leave the parent-signal abort listener attached
   * — accumulating one stale dispatcher per failed turn in a long-lived
   * session.
   *
   * Two states matter at call time:
   *
   *   - Executor already discarded (Turn fired `discard('aborted' |
   *     'unauthorized' | 'stream-error')`). The cancellation listener
   *     already ran `cancelInFlight()`; we just `dispose()`. Any
   *     `reason` passed here is dropped — "first reason wins" via
   *     `executor.discard()`'s idempotency would have ignored it anyway.
   *
   *   - Executor open (Turn ended normally with `close()`, OR exception
   *     escaped Turn pre-discard, OR the consumer-side catch fires
   *     before Turn's catch). We call `discard(reason)` which fires the
   *     cancellation listener → cancels in-flight → wipes buffered
   *     results. **Note**: the normal-completion path lands here too,
   *     because Turn's `finally` calls `close()` (not `discard()`).
   *     That means `shutdown(undefined)` on a happy turn does set the
   *     discard reason to `undefined` — harmless given no production
   *     consumer reads `getDiscardReason()` outside tests, but worth
   *     understanding before adding such a consumer.
   *
   * Idempotent: a second `shutdown()` early-returns via the `disposed`
   * guard, so the first call's reason cannot be overwritten.
   */
  shutdown(reason?: StreamingToolExecutorDiscardReason): void {
    if (this.disposed) return;
    if (!this.executor.isDiscarded()) {
      // Open executor (normal completion path OR mid-throw before Turn
      // discarded). Fire discard to cascade through the listener and
      // wipe buffered state.
      this.executor.discard(reason);
    } else {
      // Already discarded by Turn — cancellation listener already ran.
      // Belt-and-suspenders cancelInFlight() in case anything raced.
      this.cancelInFlight();
    }
    this.dispose();
  }

  private dispatch(request: ToolCallRequestInfo): void {
    const ctrl = this.abortController;
    // Resolve per-request options (progress / update callbacks) via the
    // factory, defensively swallowing a throwing factory so a misbehaving
    // consumer can't crash the stream loop — the early dispatch just
    // runs with empty options and loses progress UX, matching the
    // pre-factory behaviour.
    let options: ExecuteToolCallOptions = {};
    if (this.optionsFor) {
      try {
        options = this.optionsFor(request);
      } catch {
        options = {};
      }
    }
    const promise = executeToolCall(this.config, request, ctrl.signal, options)
      .then((response) => {
        if (this.inFlight.get(request.callId) !== promise) {
          // The dispatcher reset/discarded after this dispatch fired. The
          // matching functionCall is no longer attached to this batch's
          // history slot, so dropping the response is the correct
          // outcome — see the stale-callback hazard note on
          // StreamingToolExecutor.recordResult().
          return undefined;
        }
        this.executor.recordResult(response);
        return response;
      })
      .catch((err: unknown) => {
        if (this.inFlight.get(request.callId) !== promise) {
          // Same orphan guard as the resolve path.
          return undefined;
        }
        // Surface the failure as a tool-error response so the consumer
        // submits the matching functionResponse instead of leaving an
        // unpaired functionCall. `executeToolCall` already wraps known
        // tool failures into a ToolCallResponseInfo with error set;
        // anything that escapes that path is a programmer / transport
        // error we want visible.
        const message =
          err instanceof Error ? err.message : `Unknown error: ${String(err)}`;
        const errored: ToolCallResponseInfo = {
          callId: request.callId,
          responseParts: [
            {
              functionResponse: {
                id: request.callId,
                name: request.name,
                response: { error: message },
              },
            },
          ],
          resultDisplay: message,
          error: err instanceof Error ? err : new Error(message),
          errorType: undefined,
        };
        this.executor.recordResult(errored);
        return errored;
      });
    this.inFlight.set(request.callId, promise);
  }

  private cancelInFlight(): void {
    if (this.inFlight.size === 0) {
      // Still need a fresh controller for any post-reset accepts on the
      // same dispatcher — otherwise the next batch would inherit the
      // previous batch's already-aborted signal.
      this.abortController = this.makeChildAbort();
      return;
    }
    this.abortController.abort();
    this.inFlight.clear();
    this.abortController = this.makeChildAbort();
  }

  private makeChildAbort(): AbortController {
    const ctrl = new AbortController();
    if (this.parentSignal.aborted) ctrl.abort();
    return ctrl;
  }
}

/**
 * RFC #4387 Phase 3 initial-scope classifier. Returns true iff the tool
 * call is safe to start before the model stream completes.
 *
 * Allowed:
 *   - Kind.Read / Kind.Search / Kind.Fetch (read-only by definition)
 *   - Kind.Execute with a command the synchronous shell-readonly checker
 *     recognises (`git log`, `cat`, etc.) — matches the partitioner used
 *     by {@link CoreToolScheduler}.
 *
 * Explicitly NOT allowed:
 *   - AGENT — pending separate review (RFC §3.4).
 *   - Edit / Write / Delete / Move — side-effecting; user might not have
 *     confirmed yet.
 *   - structured_output / unknown tools — sibling-suppression semantics
 *     are not safe to bypass mid-stream; the consumer should gate the
 *     entire dispatcher off when `--json-schema` is active.
 *   - Tools requiring confirmation — the early path bypasses the UI's
 *     approval flow.
 *
 * Fail-closed for unknown tool names (e.g. an MCP tool not in the
 * registry yet): the post-stream path will pick it up normally.
 */
export function isEarlyDispatchSafe(
  config: Config,
  request: ToolCallRequestInfo,
): boolean {
  const canonical =
    (ToolNamesMigration as Record<string, string>)[request.name] ??
    request.name;

  // Phase 3 hard exclusions — even if the underlying tool kind reads as
  // safe, these classes need their own review (see RFC §3.4).
  if (canonical === ToolNames.AGENT) return false;
  if (canonical === ToolNames.STRUCTURED_OUTPUT) return false;

  const tool = config.getToolRegistry().getTool(canonical);
  if (!tool) return false;

  if (tool.kind === Kind.Execute) {
    // `args` is typed `Record<string, unknown>` upstream but a malformed
    // provider chunk could feed `null` through — guard explicitly so the
    // classifier returns false instead of throwing a TypeError that
    // would crash the consumer's stream loop.
    const args = request.args as { command?: unknown } | null | undefined;
    const command = args?.command;
    if (typeof command !== 'string') return false;
    try {
      const stripped = stripShellWrapper(command);
      // SECURITY: `stripShellWrapper` returns ONLY the inner argument
      // of a `bash -c "..."` / `sh -c '...'` wrapper, silently dropping
      // anything that follows the closing quote. We previously tried to
      // detect this by checking what trailed the stripped substring in
      // the original, but `lastIndexOf(stripped)` is bypassable when the
      // inner command's text also appears in the trailing destructive
      // payload (e.g. `bash -c "ls" && rm -rf / && ls`, or even
      // `bash -c "echo safe" ; rm -rf / # echo safe` where the comment
      // re-introduces the inner string). Any positional check based on
      // substring matching admits this class of bypass.
      //
      // The conservative fix: refuse early dispatch for ANY shell call
      // that was peeled by `stripShellWrapper`. The post-stream
      // permission flow still runs the command normally with proper
      // AST-based read-only analysis (shellAstParser) and user
      // confirmation; we just don't get to overlap it with the stream.
      // For everyday `git log`, `cat`, etc. (no wrapper) the early
      // path stays fast.
      if (stripped !== command.trim()) return false;
      return isShellCommandReadOnly(stripped);
    } catch {
      return false;
    }
  }

  return CONCURRENCY_SAFE_KINDS.has(tool.kind);
}
