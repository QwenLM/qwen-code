package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.protocol.ProviderRuntimeProtocol;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeExecutionState.OwnedExecution;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedHoldFamily;

import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiConsumer;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.MAX_CAS_ATTEMPTS;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapStoreFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.notFound;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.runtimeMap;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;

final class RuntimeExecutionCancellation {
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeExecutionState executionState;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeTransport transport;
    private final Set<String> invocations;
    private final ScheduledExecutorService scheduler;
    private final Duration operationLeaseDuration;
    private final AtomicBoolean closed;

    RuntimeExecutionCancellation(RuntimeBindingRegistry bindingRegistry,
            RuntimeExecutionState executionState,
            ToolExecutionRepository executionRepository,
            RuntimeTransport transport,
            Set<String> invocations,
            ScheduledExecutorService scheduler,
            Duration operationLeaseDuration,
            AtomicBoolean closed) {
        this.bindingRegistry = bindingRegistry;
        this.executionState = executionState;
        this.executionRepository = executionRepository;
        this.transport = transport;
        this.invocations = invocations;
        this.scheduler = scheduler;
        this.operationLeaseDuration = operationLeaseDuration;
        this.closed = closed;
    }

    static final Set<String> RUNTIME_EXECUTION_STATES = Set.of(
            "prepared", "executing", "cancel_requested", "settled",
            "unknown");

    CompletionStage<ToolExecutionRecord> cancelExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, BiConsumer<SessionContext, ToolExecutionRecord> dispatch) {
        requireOpen(closed);
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return mapStoreFailure(safeStage(() -> {
            OwnedExecution owned = executionState.requireOwnership(harnessSessionId,
                    runtimeSessionId, executionId);
            ToolExecutionRecord stored = owned.record();
            if (stored.isTerminal()) {
                if (!isPreparedProviderCancellation(stored)) {
                    return CompletableFuture.completedFuture(stored);
                }
                RuntimeBindingRecord binding = owned.binding();
                // Only a READY Session whose binding can still answer may hold
                // the worker's preparation; anywhere else the terminal receipt
                // stands alone, the same rule that lets Broker HTTP read
                // terminal receipts without a READY Session.
                if (owned.session().getState() != RuntimeSessionRecord.State.READY
                        || binding.getState() != RuntimeBindingRecord.State.READY
                                && binding.getState() != RuntimeBindingRecord.State.DRAINING) {
                    return CompletableFuture.completedFuture(stored);
                }
                // That worker may still hold the preparation, so the
                // cancellation is not acknowledged without its evidence. A
                // process without a live Session (a replaced Broker, or an
                // acquire still adopting) asks for adoption, as reconciliation
                // does; another Harness's Session under the same id stays a
                // conflict below.
                CompletableFuture<SessionContext> local = bindingRegistry.session(runtimeSessionId);
                if (local == null || !local.isDone() || local.isCompletedExceptionally()) {
                    throw unavailable("runtime_reconciliation_required",
                            "Runtime Session is not active in this Broker process; "
                                    + "acquire the Session again to confirm the cancellation");
                }
            }
            return executionState.unknownWhenAdmissionClosed(
                    bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId)
                    .thenCompose(context -> {
                        ToolExecutionRecord requested;
                        boolean publicationV3;
                        context.lock();
                        try {
                            bindingRegistry.requireReadySessionRecord(context);
                            ToolExecutionRecord current = executionState.requireExecution(
                                    context, executionId);
                            // A hold row never dispatches, so a cancel would
                            // settle it immediately — while its process
                            // provably runs. It settles only on the owner's
                            // stop evidence; stop goes through the
                            // maintenance route.
                            if (ManagedHoldFamily.of(current) != null) {
                                throw conflict("runtime_execution_conflict",
                                        "A background process settles only on stop evidence");
                            }
                            if (CsiFilesRetirementProfile.isProfile(context.binding().getRequest().getScope())
                                    && current.getAuthorizedDispatchGeneration() != null) {
                                throw conflict("csi_execution_cancel_unavailable",
                                        "An authorized private CSI execution does not support cancellation");
                            }
                            requested = requestCancel(current);
                            if (isPreparedProviderCancellation(requested)) {
                                context.beginControl();
                                return cancelPreparedProvider(context, requested);
                            }
                            publicationV3 = "deferred_v3".equals(
                                    requested.getReference().get("dispatchMode"));
                            // An UNKNOWN record may still have an invocation
                            // running in this process, or be one its original
                            // Runtime can still answer for; it gets the
                            // physical cancel below but is never settled from
                            // here.
                            if (requested.isTerminal()
                                    || (requested.getState()
                                            == ToolExecutionRecord.State.UNKNOWN
                                            && !invocations.contains(
                                                    executionId)
                                            && !publicationV3
                                            && !requested.observableAfterLoss())) {
                                return CompletableFuture.completedFuture(
                                        requested);
                            }
                        } finally {
                            context.unlock();
                        }
                        if (requested.getState()
                                == ToolExecutionRecord.State.DISPATCHING) {
                            dispatch.accept(context, requested);
                            ToolExecutionRecord latest = executionRepository
                                    .findByExecutionCallId(executionId);
                            return CompletableFuture.completedFuture(
                                    latest == null ? requested : latest);
                        }
                        if (requested.getState()
                                        == ToolExecutionRecord.State
                                                .CANCEL_REQUESTED
                                && !invocations.contains(executionId)) {
                            // Fence a lapsed claim nothing here is running. A
                            // claim the repository still holds live falls
                            // through to the physical cancel, as does an
                            // invocation still running in this process.
                            ToolExecutionRecord fenced;
                            try {
                                fenced = executionState.fenceLapsedClaim(requested);
                            } catch (RuntimeException exception) {
                                throw unavailable(
                                        "runtime_execution_cancel_failed",
                                        "Runtime execution cancellation failed",
                                        exception);
                            }
                            if (fenced == null || fenced.getState()
                                    != ToolExecutionRecord.State
                                            .CANCEL_REQUESTED) {
                                return CompletableFuture.completedFuture(
                                        fenced == null ? requested : fenced);
                            }
                        }
                        if (requested.getState()
                                        != ToolExecutionRecord.State
                                                .CANCEL_REQUESTED
                                && requested.getState()
                                        != ToolExecutionRecord.State.UNKNOWN) {
                            return CompletableFuture.completedFuture(requested);
                        }
                        bindingRegistry.requireUsableLease(context);
                        return mapFailure(safeStage(() ->
                                publicationV3
                                        ? transport.cancelV3(context.lease(), context.session(),
                                                requested.getReference()).thenApply(
                                                        RuntimeBrokerSupport::projectV3Status)
                                        : transport.cancel(context.lease(), context.session(),
                                                requested.getReference())),
                                "runtime_execution_cancel_failed",
                                "Runtime execution cancellation failed")
                                .thenApply(status -> {
                                    absorbCancellationStatus(requested, status);
                                    ToolExecutionRecord latest =
                                            executionRepository
                                                    .findByExecutionCallId(
                                                            executionId);
                                    return latest == null ? requested : latest;
                                });
                    }),
                    harnessSessionId, runtimeSessionId, executionId);
        }));
    }

    private static boolean isPreparedProviderCancellation(ToolExecutionRecord record) {
        return record.isSettled() && record.isCancelRequested()
                && record.getDispatchGeneration() == 0
                && ProviderRuntimeProtocol.isReference(record.getReference());
    }

    private CompletionStage<ToolExecutionRecord> cancelPreparedProvider(
            SessionContext context, ToolExecutionRecord requested) {
        CompletableFuture<ToolExecutionRecord> result = new CompletableFuture<>();
        result.orTimeout(Math.max(1, operationLeaseDuration.toMillis()), TimeUnit.MILLISECONDS);
        observePreparedCancellation(context, requested, safeStage(() -> {
            bindingRegistry.requireUsableLease(context);
            return transport.cancel(context.lease(), context.session(), requested.getReference());
        }), result);
        return mapFailure(result, "runtime_execution_cancel_failed",
                "Runtime execution cancellation failed")
                .whenComplete((ignored, error) -> context.endControl());
    }

    private void observePreparedCancellation(SessionContext context, ToolExecutionRecord requested,
            CompletionStage<Map<String, Object>> observation, CompletableFuture<ToolExecutionRecord> completion) {
        observation.whenComplete((status, error) -> {
            if (completion.isDone()) {
                return;
            }
            if (error != null) {
                completion.completeExceptionally(error);
                return;
            }
            try {
                if (status != null && "settled".equals(status.get("state"))
                        && status.get("result") instanceof Map<?, ?> result
                        && ("cancelled".equals(result.get("executionStatus"))
                                || "not_started".equals(result.get("executionStatus")))) {
                    completion.complete(requested);
                } else if (status != null && ("prepared".equals(status.get("state"))
                        || "executing".equals(status.get("state"))
                        || "cancel_requested".equals(status.get("state")))) {
                    scheduler.schedule(() -> {
                        if (!completion.isDone()) {
                            observePreparedCancellation(context, requested, safeStage(() -> {
                                bindingRegistry.requireUsableLease(context);
                                return transport.status(context.lease(), context.session(),
                                        requested.getReference(), requested.getLastSequence());
                            }), completion);
                        }
                    }, 25, TimeUnit.MILLISECONDS);
                } else {
                    // unknown or an unexpected terminal answer can never
                    // become the confirmation, so a retry cannot converge;
                    // fail non-retryably rather than loop the same round
                    // trip. unknown never becomes not_started evidence.
                    Object state = status == null ? null : status.get("state");
                    throw new RuntimeBrokerException(409,
                            "runtime_execution_cancel_unconfirmed",
                            "unknown".equals(state)
                                    ? "Runtime no longer retains the prepared invocation"
                                    : "Runtime did not confirm prepared invocation cancellation",
                            false);
                }
            } catch (RuntimeException failure) {
                completion.completeExceptionally(failure);
            }
        });
    }

    private ToolExecutionRecord requestCancel(
            ToolExecutionRecord initial) {
        ToolExecutionRecord current = initial;
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current.isTerminal()) {
                return current;
            }
            ToolExecutionRecord updated = executionRepository.requestCancel(
                    current.getExecutionCallId(), current.getVersion());
            if (updated != null) {
                return updated;
            }
            current = executionRepository.findByExecutionCallId(
                    current.getExecutionCallId());
            if (current == null) {
                throw notFound("runtime_execution_not_found",
                        "Runtime execution was not found");
            }
        }
        throw conflict("runtime_execution_state_conflict",
                "Runtime execution changed while requesting cancellation");
    }

    private void absorbCancellationStatus(ToolExecutionRecord requested,
            Map<String, Object> status) {
        Object state = status == null ? null : status.get("state");
        if (!(state instanceof String)
                || !RUNTIME_EXECUTION_STATES.contains(state)) {
            throw unavailable("runtime_execution_cancel_failed",
                    "Runtime cancellation returned an invalid status");
        }
        if (!"settled".equals(state)) {
            return;
        }
        Map<String, Object> result = runtimeMap(status.get("result"),
                "cancellation result");
        try {
            executionState.settleExecution(requested, result);
        } catch (IllegalArgumentException exception) {
            throw unavailable("runtime_execution_cancel_failed",
                    "Runtime cancellation returned an invalid result",
                    exception);
        } catch (RuntimeBrokerException exception) {
            if (!"runtime_execution_state_conflict".equals(
                    exception.getCode())) {
                throw exception;
            }
            // The Runtime settled the call after this claim lapsed; fence it
            // for reconciliation instead of reporting a state conflict. The
            // conflict stands only while the repository still holds the
            // claim live; a record another writer settled is returned.
            ToolExecutionRecord latest = executionState.fenceLapsedClaim(
                    executionRepository.findByExecutionCallId(
                            requested.getExecutionCallId()));
            if (latest == null || (!latest.isTerminal()
                    && latest.getState()
                            != ToolExecutionRecord.State.UNKNOWN)) {
                throw exception;
            }
        }
    }
}
