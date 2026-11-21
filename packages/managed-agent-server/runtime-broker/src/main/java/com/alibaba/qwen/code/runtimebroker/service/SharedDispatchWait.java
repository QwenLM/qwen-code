package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.StoreFailureException;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.VerifiedDispatchPayload;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

/**
 * The bounded wait for a shared Workspace dispatch slot, split out of {@link
 * RuntimeExecutionDispatcher} so that class stays inside its size ratchet.
 *
 * <p>A wait owns its PREPARED row: every exit that cannot hand the row to a
 * dispatch settles it, because nothing else reconciles a PREPARED execution.
 */
final class SharedDispatchWait {
    /** Dispatches a claim this wait owns and completes with its outcome. */
    interface ClaimDispatcher {
        CompletionStage<Void> dispatch(SessionContext context,
                ToolExecutionRecord claimed, Map<String, Object> payload,
                RuntimePublicationGrant grant, String externalChannelId);
    }

    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeBindingRepository bindingRepository;
    private final ToolExecutionRepository executionRepository;
    private final ScheduledExecutorService scheduler;
    private final ClaimDispatcher claimDispatcher;
    private final String brokerOwnerId;
    private final Duration dispatchLeaseDuration;
    private final Duration resultWindow;
    private final Clock clock;
    private final AtomicBoolean closed;
    private final ConcurrentMap<String, Awaiting> awaiting =
            new ConcurrentHashMap<>();

    private record Awaiting(CompletableFuture<Void> queued,
            ToolExecutionRecord prepared) {
    }

    SharedDispatchWait(RuntimeBindingRegistry bindingRegistry,
            RuntimeBindingRepository bindingRepository,
            ToolExecutionRepository executionRepository,
            ScheduledExecutorService scheduler,
            ClaimDispatcher claimDispatcher, String brokerOwnerId,
            Duration dispatchLeaseDuration, Duration resultWindow, Clock clock,
            AtomicBoolean closed) {
        this.bindingRegistry = bindingRegistry;
        this.bindingRepository = bindingRepository;
        this.executionRepository = executionRepository;
        this.scheduler = scheduler;
        this.claimDispatcher = claimDispatcher;
        this.brokerOwnerId = brokerOwnerId;
        this.dispatchLeaseDuration = dispatchLeaseDuration;
        this.resultWindow = resultWindow;
        this.clock = clock;
        this.closed = closed;
    }

    /**
     * Close rejects every queued tick with shutdownNow(), so settle the rows
     * those waits own before unblocking them, or they stay active and fence
     * the binding's release.
     */
    void cancelPendingRequests() {
        awaiting.values().forEach(wait -> {
            try {
                settleStrandedPrepared(wait.prepared(), "dispatch_failed",
                        "Shared Workspace dispatch failed before claim");
            } catch (RuntimeException | Error ignored) {
                // Close still has to unblock the caller's wait below.
            }
            wait.queued().completeExceptionally(unavailable(
                    "runtime_admission_closed", "Runtime broker is closing"));
        });
    }

    CompletionStage<Void> await(SessionContext context,
            ToolExecutionRecord prepared, Map<String, Object> payload,
            RuntimePublicationGrant grant,
            VerifiedDispatchPayload verifiedPayload, String externalChannelId) {
        // Keep a single Future per waiting request; a long-lived UNKNOWN
        // occupant must not build a recursive chain. The wait is bounded like
        // the v3 result poll: backoff between attempts and a deadline, so an
        // occupant that never settles answers a conflict instead of retrying
        // forever on the shared coordination thread.
        CompletableFuture<Void> queued = new CompletableFuture<>();
        Awaiting wait = new Awaiting(queued, prepared);
        awaiting.put(prepared.getExecutionCallId(), wait);
        queued.whenComplete((ignored, error) ->
                awaiting.remove(prepared.getExecutionCallId(), wait));
        // close() sets closed, then sweeps awaiting, then shuts the scheduler
        // down. A wait that registers after the sweep would have its first
        // tick discarded by shutdownNow() and never settle its PREPARED row,
        // so re-read closed here: every close either swept this entry or is
        // already visible.
        if (closed.get()) {
            awaiting.remove(prepared.getExecutionCallId(), wait);
            settleStrandedPrepared(prepared, "dispatch_failed",
                    "Shared Workspace dispatch failed before claim");
            throw unavailable("runtime_admission_closed",
                    "Runtime broker is closing");
        }
        Instant deadline = clock.instant().plus(resultWindow);
        AtomicInteger attempt = new AtomicInteger();
        Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (queued.isDone()) {
                    return;
                }
                try {
                    requireOpen(closed);
                    if (!clock.instant().isBefore(deadline)) {
                        // The slot never freed. The conflict below feeds a
                        // write-only future (dispatches is consumed solely by
                        // cancelPendingOperations), so it can never surface to
                        // the caller on its own. Settle the stranded PREPARED
                        // execution first, so the record the caller polls
                        // carries the refusal instead of hanging PREPARED with
                        // no dispatch owner.
                        settleStrandedPrepared(prepared, "dispatch_timeout",
                                "Shared Workspace dispatch slot did not free in time");
                        throw conflict("runtime_execution_conflict",
                                "Shared Workspace dispatch slot did not free in time");
                    }
                    ToolExecutionRecord waiting =
                            executionRepository.findByExecutionCallId(
                                    prepared.getExecutionCallId());
                    if (waiting == null || !waiting.sameIdentity(prepared)) {
                        queued.complete(null);
                        return;
                    }
                    // A claim this wait committed, whose dispatch then failed
                    // retryably before the row reached EXECUTING, leaves a
                    // DISPATCHING row this broker owns. Nothing renews or
                    // reconciles it, so reporting success here would complete
                    // the call over a dispatch that never ran: re-drive it. A
                    // DISPATCHING row under another owner is that attempt's
                    // work, and the wait completes as before.
                    if (waiting.getState()
                            == ToolExecutionRecord.State.DISPATCHING
                            && brokerOwnerId.equals(waiting.getDispatchOwner())) {
                        redrive(context, waiting, payload, grant,
                                externalChannelId, queued);
                        return;
                    }
                    if (waiting.getState()
                            != ToolExecutionRecord.State.PREPARED) {
                        queued.complete(null);
                        return;
                    }
                    ToolExecutionRecord next;
                    context.lock();
                    try {
                        bindingRegistry.requireReadySessionRecord(context);
                        bindingRepository.requireHarnessAdmission(
                                context.binding().getRequest(),
                                context.session().getScope(),
                                context.session().getHarnessSessionId(),
                                null);
                        next = executionRepository.claimValidatedDispatch(
                                prepared.getExecutionCallId(), brokerOwnerId,
                                dispatchLeaseDuration, verifiedPayload);
                    } finally {
                        context.unlock();
                    }
                    if (next == null) {
                        scheduler.schedule(this,
                                RuntimeExecutionDispatcher.v3PollDelayMillis(
                                        attempt.getAndIncrement()),
                                TimeUnit.MILLISECONDS);
                    } else {
                        redrive(context, next, payload, grant,
                                externalChannelId, queued);
                    }
                } catch (RuntimeException | Error error) {
                    // A transient store or admission failure before the
                    // deadline is the contended state this wait exists for: the
                    // occupying dispatch holds the very binding row whose
                    // SELECT ... FOR UPDATE this tick takes, so a lock-wait
                    // timeout is most likely exactly while the slot is busy. It
                    // must reschedule like an occupied slot, not terminally
                    // settle a tool that was never attempted. The deadline is
                    // still the single ceiling: every tick re-reads it above.
                    if (retryableWaitFailure(error)
                            && clock.instant().isBefore(deadline)
                            && rescheduleTick(this, attempt)) {
                        return;
                    }
                    // Every exceptional exit feeds the same write-only future,
                    // so the stranded PREPARED row must settle here too or it
                    // hangs the caller's poll and fences the binding's release
                    // forever (the reconciler skips PREPARED rows).
                    try {
                        settleStrandedPrepared(prepared, "dispatch_failed",
                                "Shared Workspace dispatch failed before claim");
                    } catch (RuntimeException | Error settleFailure) {
                        error.addSuppressed(settleFailure);
                    }
                    queued.completeExceptionally(error);
                }
            }
        };
        try {
            scheduler.schedule(tick, 250, TimeUnit.MILLISECONDS);
        } catch (RuntimeException | Error rejected) {
            // The dispatch between the null claim and this first schedule can
            // race a closing broker: the scheduler is shut down, so the
            // PREPARED row would otherwise stay active with no owner and fence
            // the binding's release forever. Settle it before propagating,
            // exactly like the tick's own exceptional exit.
            awaiting.remove(prepared.getExecutionCallId(), wait);
            try {
                settleStrandedPrepared(prepared, "dispatch_failed",
                        "Shared Workspace dispatch failed before claim");
            } catch (RuntimeException | Error settleFailure) {
                rejected.addSuppressed(settleFailure);
            }
            throw rejected;
        }
        return queued;
    }

    /**
     * Drives a claim this wait owns and completes the wait with its outcome. A
     * claim whose dispatch fails retryably stays DISPATCHING; the next tick
     * re-enters here with the re-read row instead of reporting success.
     */
    private void redrive(SessionContext context, ToolExecutionRecord claimed,
            Map<String, Object> payload, RuntimePublicationGrant grant,
            String externalChannelId, CompletableFuture<Void> queued) {
        claimDispatcher.dispatch(context, claimed, payload, grant,
                externalChannelId).whenComplete((ignored, error) -> {
                    if (error == null) {
                        queued.complete(null);
                    } else {
                        queued.completeExceptionally(unwrap(error));
                    }
                });
    }

    /**
     * A store outage or a retryable refusal is transient by contract: the same
     * failure on the first attempt leaves the row PREPARED and answers a
     * retryable 503. Anything else — an unclassified invariant violation, a
     * non-retryable broker refusal or a JVM error — is terminal for this wait,
     * because the waiter owns the PREPARED row.
     */
    private static boolean retryableWaitFailure(Throwable error) {
        Throwable cause = unwrap(error);
        return cause instanceof StoreFailureException
                || cause instanceof RuntimeBrokerException failure
                        && failure.isRetryable();
    }

    /**
     * A closed broker shuts the scheduler down, so a rejected reschedule is
     * itself the terminal signal and the caller must settle the row.
     */
    private boolean rescheduleTick(Runnable tick, AtomicInteger attempt) {
        try {
            scheduler.schedule(tick,
                    RuntimeExecutionDispatcher.v3PollDelayMillis(
                            attempt.getAndIncrement()),
                    TimeUnit.MILLISECONDS);
            return true;
        } catch (RuntimeException | Error rejected) {
            return false;
        }
    }

    private void settleStrandedPrepared(ToolExecutionRecord prepared,
            String errorType, String message) {
        ToolExecutionRecord stranded = executionRepository
                .findByExecutionCallId(prepared.getExecutionCallId());
        if (stranded != null && stranded.sameIdentity(prepared)
                && stranded.getState() == ToolExecutionRecord.State.PREPARED) {
            executionRepository.settlePrepared(stranded, Map.of(
                    "executionStatus", "not_started",
                    "responseParts", List.of(),
                    "error", Map.of("type", errorType, "message", message)),
                    clock.instant());
        }
    }
}
