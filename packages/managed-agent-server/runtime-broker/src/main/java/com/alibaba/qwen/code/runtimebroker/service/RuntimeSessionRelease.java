package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
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

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.MAX_CAS_ATTEMPTS;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.failed;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.notFound;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

/**
 * Session-release CAS transitions and the guarded release sweep, shared by
 * the facade's routine release path and the drain cascade.
 */
final class RuntimeSessionRelease {
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeProvisioner provisioner;
    private final RuntimeTransport transport;
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeExecutionRecovery executionRecovery;

    RuntimeSessionRelease(RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            RuntimeProvisioner provisioner,
            RuntimeTransport transport,
            RuntimeBindingRegistry bindingRegistry,
            RuntimeExecutionRecovery executionRecovery) {
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.provisioner = provisioner;
        this.transport = transport;
        this.bindingRegistry = bindingRegistry;
        this.executionRecovery = executionRecovery;
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

    private CompletionStage<Boolean> releaseSessionAfterSweep(
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

    private CompletionStage<Boolean> completeSessionRelease(
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
            releasing = transitionSessionToReleasing(context);
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
                            finishSessionRelease(releasing);
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

    private CompletionStage<Boolean> releaseUnusableSession(SessionContext context) {
        bindingRegistry.invalidateBinding(context.binding());
        return failed(unavailable("runtime_reconciliation_required",
                "Runtime release requires durable proof that old writers stopped"));
    }

    RuntimeSessionRecord transitionSessionToReleasing(
            SessionContext context) {
        RuntimeSessionRecord current = sessionRepository.findById(
                context.session().getScope(),
                context.session().getRuntimeSessionId());
        if (current == null) {
            throw notFound("runtime_session_not_found",
                    "Runtime Session was not found");
        }
        if (CsiFilesRetirementProfile.isProfile(current.getSession().getScope())) {
            throw CsiFilesRetirementProfile.releaseUnavailable();
        }
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current.getState()
                    == RuntimeSessionRecord.State.RELEASING) {
                // A row already persisted as RELEASING can predate the
                // guarded transition: an older peer's check-then-act let an
                // admission in and its worker release then failed. Admission
                // needs READY under the row lock, so nothing new can join
                // now, but completing this release would free a worker that
                // is still running a tool, so the retry is only idempotent
                // once nothing active is left.
                if (executionRepository.hasActiveByRuntimeSession(
                        current.getBindingId(),
                        current.getRuntimeGeneration(),
                        current.getRuntimeSessionId())) {
                    throw conflict("runtime_session_busy",
                            "Runtime Session has an active operation");
                }
                return current;
            }
            if (current.getState()
                    == RuntimeSessionRecord.State.RELEASED) {
                return current;
            }
            if (current.getState() != RuntimeSessionRecord.State.READY
                    && current.getState() != RuntimeSessionRecord.State.ACQUIRING) {
                throw conflict("runtime_session_not_ready",
                        "Runtime Session is not ready for release");
            }
            // The transition and the no-active-execution check commit in one
            // transaction under the Session row lock that admission also
            // takes, so a concurrent Broker process cannot admit into the
            // gap between the check and the CAS.
            RuntimeSessionRecord updated =
                    bindingRepository.beginSessionRelease(sessionRepository,
                            executionRepository, current);
            if (updated != null) {
                return updated;
            }
            current = sessionRepository.findById(
                    context.session().getScope(),
                    context.session().getRuntimeSessionId());
            if (current == null) {
                throw conflict("runtime_session_state_conflict",
                        "Runtime Session changed while releasing");
            }
        }
        throw conflict("runtime_session_state_conflict",
                "Runtime Session changed while releasing");
    }

    void finishSessionRelease(RuntimeSessionRecord releasing) {
        finishSessionRelease(releasing, null);
    }

    void finishSessionRelease(RuntimeSessionRecord releasing, RuntimeBindingRecord stopped) {
        RuntimeSessionRecord current = releasing;
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current.getState() == RuntimeSessionRecord.State.RELEASED) {
                return;
            }
            RuntimeSessionRecord updated = stopped == null
                    ? bindingRepository.completeSessionRelease(sessionRepository, current)
                    : bindingRepository.completeStoppedSessionRelease(sessionRepository, executionRepository, current, stopped);
            if (updated != null
                    || current.getState()
                            == RuntimeSessionRecord.State.RELEASED) {
                return;
            }
            current = sessionRepository.findById(
                    releasing.getSession().getScope(),
                    releasing.getRuntimeSessionId());
            if (current != null && current.getState()
                    == RuntimeSessionRecord.State.RELEASED) {
                return;
            }
            if (current == null || current.getState()
                            != RuntimeSessionRecord.State.RELEASING) {
                throw conflict("runtime_session_state_conflict",
                        "Runtime Session changed after release");
            }
        }
        throw conflict("runtime_session_state_conflict",
                "Runtime Session changed after release");
    }
}
