package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;

import java.util.HashSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.failed;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

/**
 * The Session release arm of the Broker: the per-context release latch, the
 * background sweep decision and the transport release completion. Split out
 * of RuntimeBrokerService verbatim; the stages, lock order and refusal codes
 * are the ones the service ran inline.
 */
final class RuntimeSessionRelease {
    private final RuntimeBrokerService service;
    private final RuntimeSessionRepository sessionRepository;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeProvisioner provisioner;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeExecutionRecovery executionRecovery;
    private final RuntimeTransport transport;

    RuntimeSessionRelease(RuntimeBrokerService service, RuntimeSessionRepository sessionRepository,
            RuntimeBindingRepository bindingRepository, RuntimeBindingRegistry bindingRegistry,
            RuntimeProvisioner provisioner, ToolExecutionRepository executionRepository,
            RuntimeExecutionRecovery executionRecovery, RuntimeTransport transport) {
        this.service = service;
        this.sessionRepository = sessionRepository;
        this.bindingRepository = bindingRepository;
        this.bindingRegistry = bindingRegistry;
        this.provisioner = provisioner;
        this.executionRepository = executionRepository;
        this.executionRecovery = executionRecovery;
        this.transport = transport;
    }

    CompletionStage<Boolean> releaseSession(
            SessionContext context, boolean drain) {
        RuntimeSessionRecord persisted = sessionRepository.findById(context.session().getScope(),
                context.session().getRuntimeSessionId());
        if (persisted != null && persisted.getState() == RuntimeSessionRecord.State.RELEASED) {
            bindingRegistry.removeSession(context.session().getRuntimeSessionId());
            return CompletableFuture.completedFuture(true);
        }
        RuntimeBindingRecord parent = bindingRepository.findById(context.binding().getBindingId());
        if (parent == null || parent.getGeneration() != context.binding().getGeneration()
                || parent.getState() != RuntimeBindingRecord.State.READY
                        && parent.getState() != RuntimeBindingRecord.State.DRAINING) {
            return failed(unavailable("runtime_reconciliation_required",
                    "Runtime release requires recovery of the original generation"));
        }
        if (!provisioner.isUsable(context.lease())) {
            if (parent.isDrainRequested()) {
                return failed(conflict("workspace_close_identity_unverified", "Original worker cannot release its Session"));
            }
            return releaseUnusableSession(context);
        }
        CompletableFuture<Boolean> attempt = new CompletableFuture<>();
        context.lock();
        try {
            if (context.releaseAttempt() != null) {
                return context.releaseAttempt();
            }
            context.releaseAttempt(attempt);
        } finally {
            context.unlock();
        }
        CompletionStage<Boolean> run = executionRecovery.settleUnprovenBackgroundRows(context, drain)
                .thenCompose(ignored -> releaseSessionAfterSweep(context, drain));
        run.whenComplete((result, error) -> {
            if (error != null) {
                context.releaseAttempt(null);
                attempt.completeExceptionally(unwrap(error));
            } else {
                // A negative answer keeps the join but frees the latch, so
                // the next caller gets a fresh attempt, not this one.
                if (!Boolean.TRUE.equals(result)) {
                    context.releaseAttempt(null);
                }
                attempt.complete(result);
            }
        });
        return attempt;
    }

    CompletionStage<Boolean> releaseSessionAfterSweep(
            SessionContext context, boolean drain) {
        boolean backgroundBusy;
        context.lock();
        try {
            if (context.release() != null) {
                return context.release();
            }
            if (context.hasActiveControl()
                    || executionRepository.hasActiveByRuntimeSession(
                            context.binding().getBindingId(), context.binding().getGeneration(),
                            context.session().getRuntimeSessionId(),
                            new HashSet<>(context.backgroundProcesses()))) {
                throw conflict("runtime_session_busy",
                        "Runtime Session has an active operation");
            }
            backgroundBusy = executionRepository.hasActiveByRuntimeSession(
                    context.binding().getBindingId(), context.binding().getGeneration(),
                    context.session().getRuntimeSessionId());
        } finally {
            context.unlock();
        }
        if (!backgroundBusy) {
            return completeSessionRelease(context);
        }
        if (!drain) {
            // Routine release: the sweep stopped nothing, so a live hold is
            // the designed state, not a wedge — the run holds its Runtime
            // until it is proven gone, and the answer names the hold so the
            // Harness never mistakes it for the unproven busy below.
            return failed(conflict("runtime_session_held",
                    "Runtime Session is held by a live background run"));
        }
        // The drain sweep issued each row's stop and settled every end it
        // could prove; what it could not prove keeps its hold — busy is the
        // accurate answer here, never a speculative teardown.
        return failed(conflict("runtime_session_busy",
                "Runtime Session has an active background process"));
    }

    CompletionStage<Boolean> completeSessionRelease(
            SessionContext context) {
        CompletableFuture<Boolean> result;
        RuntimeSessionRecord releasing;
        context.lock();
        try {
            if (context.release() != null) {
                return context.release();
            }
            // Active executions are rejected inside the transition's own
            // transaction by beginSessionRelease; only the process-local
            // control check stays here.
            if (context.hasActiveControl()) {
                throw conflict("runtime_session_busy",
                        "Runtime Session has an active operation");
            }
            releasing = service.transitionSessionToReleasing(context);
            if (releasing.getState()
                    == RuntimeSessionRecord.State.RELEASED) {
                bindingRegistry.removeSession(context.session().getRuntimeSessionId());
                return CompletableFuture.completedFuture(true);
            }
            result = new CompletableFuture<>();
            context.release(result);
        } finally {
            context.unlock();
        }
        mapFailure(safeStage(() -> transport.release(context.lease(),
                context.session())), "runtime_session_release_failed",
                "Runtime Session release failed")
                .whenComplete((released, error) -> {
                    if (error != null) {
                        context.release(null);
                        result.completeExceptionally(unwrap(error));
                    } else if (!Boolean.TRUE.equals(released)) {
                        context.release(null);
                        result.complete(false);
                    } else {
                        try {
                            service.finishSessionRelease(releasing);
                            bindingRegistry.removeSession(context.session()
                                    .getRuntimeSessionId());
                            result.complete(true);
                        } catch (RuntimeException exception) {
                            context.release(null);
                            result.completeExceptionally(exception);
                        }
                    }
                });
        return result;
    }

    CompletionStage<Boolean> releaseUnusableSession(SessionContext context) {
        bindingRegistry.invalidateBinding(context.binding());
        return failed(unavailable("runtime_reconciliation_required",
                "Runtime release requires durable proof that old writers stopped"));
    }
}
