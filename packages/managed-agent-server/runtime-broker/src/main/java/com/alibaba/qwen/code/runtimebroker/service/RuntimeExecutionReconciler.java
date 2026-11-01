package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.ExecutionReconciliation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;

import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.evidenceUnavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.MAX_CAS_ATTEMPTS;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.RUNTIME_STATUS_STATES;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.immutableMap;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.notFound;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

final class RuntimeExecutionReconciler {
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeExecutionState executionState;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeProvisioner provisioner;
    private final RuntimeTransport transport;
    private final RuntimePublicationVerifier publicationVerifier;
    private final Duration operationLeaseDuration;
    private final Clock clock;
    private final AtomicBoolean closed;
    private final ExecutionObservationCooldown observationCooldown;

    RuntimeExecutionReconciler(RuntimeBindingRegistry bindingRegistry,
            RuntimeExecutionState executionState,
            ToolExecutionRepository executionRepository,
            RuntimeProvisioner provisioner,
            RuntimeTransport transport,
            RuntimePublicationVerifier publicationVerifier,
            Duration operationLeaseDuration,
            Clock clock,
            AtomicBoolean closed,
            ExecutionObservationCooldown observationCooldown) {
        this.bindingRegistry = bindingRegistry;
        this.executionState = executionState;
        this.executionRepository = executionRepository;
        this.provisioner = provisioner;
        this.transport = transport;
        this.publicationVerifier = publicationVerifier;
        this.operationLeaseDuration = operationLeaseDuration;
        this.clock = clock;
        this.closed = closed;
        this.observationCooldown = observationCooldown;
    }

    private final ConcurrentMap<String, CompletableFuture<ExecutionReconciliation>> reconciliations = new ConcurrentHashMap<>();

    void cancelPendingOperations() {
        reconciliations.values().forEach(future -> future.cancel(false));
    }

    static final Set<String> RUNTIME_STATUS_FIELDS = Set.of(
            "state", "result");

    /**
     * Asks the original Runtime once whether an {@code UNKNOWN} execution
     * settled, and settles the record only on that evidence. Any other
     * answer, and any failure, leaves it {@code UNKNOWN}. This never executes
     * or re-claims the dispatch, and it never retries: polling belongs to
     * the caller. A record that is not {@code UNKNOWN} is answered from the
     * repository before any Session or liveness check.
     */
    CompletionStage<ExecutionReconciliation> reconcileExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen(closed);
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return mapFailure(safeStage(() -> reconcile(harnessId, runtimeId,
                executionId)), "runtime_execution_reconcile_failed",
                "Runtime execution reconciliation failed");
    }

    /**
     * The HTTP face's automatic observation of an UNKNOWN execution: the
     * same evidence-only lookup as {@link #reconcileExecution}, except that
     * a lookup that just ran cools the execution for a short window, so
     * rapid polling shares the one answer instead of fanning every request
     * through to the worker (issue #13183 saw hundreds of status calls per
     * execution this way).
     */
    CompletionStage<ExecutionReconciliation> observeExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen(closed);
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return mapFailure(safeStage(() -> reconcile(harnessId, runtimeId,
                executionId, true)), "runtime_execution_reconcile_failed",
                "Runtime execution reconciliation failed");
    }

    private CompletionStage<ExecutionReconciliation> reconcile(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        return reconcile(harnessSessionId, runtimeSessionId, executionCallId,
                false);
    }

    private CompletionStage<ExecutionReconciliation> reconcile(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, boolean cooled) {
        ToolExecutionRecord unknown = executionState.requireOwnedExecution(harnessSessionId,
                runtimeSessionId, executionCallId);
        if (unknown.getState() != ToolExecutionRecord.State.UNKNOWN) {
            return CompletableFuture.completedFuture(notUnknown(unknown,
                    null));
        }
        if ("deferred_v3".equals(unknown.getReference().get("dispatchMode"))
                && publicationVerifier != null) {
            Map<String, Object> durable = publicationVerifier.finished(unknown);
            if (durable != null) {
                return CompletableFuture.completedFuture(absorbRuntimeStatus(unknown,
                        Map.of("state", "settled", "result", durable), false));
            }
        }
        CompletableFuture<SessionContext> local = bindingRegistry.session(
                runtimeSessionId);
        // Process-local Sessions are keyed by Runtime Session id alone, so a
        // Session another Harness holds under the same id is not a route.
        SessionContext context = local == null || !local.isDone()
                || local.isCompletedExceptionally() ? null : local.join();
        if (context == null || !context.session().getHarnessSessionId()
                .equals(harnessSessionId)) {
            // No attested route in this process yet: ask for adoption only
            // while the original generation could still answer.
            return bindingRegistry.persistedSession(harnessSessionId, runtimeSessionId)
                    .thenApply(ignored -> {
                        bindingRegistry.requireAnswerableBinding(unknown);
                        throw unavailable("runtime_reconciliation_required",
                                "Runtime Session is not active in this "
                                        + "Broker process; adopt its binding "
                                        + "and acquire the Session again");
                    });
        }
        return reconcileInContext(context, unknown, false, cooled);
    }

    CompletionStage<ExecutionReconciliation> reconcileInContext(
            SessionContext context, ToolExecutionRecord unknown,
            boolean takeover) {
        return reconcileInContext(context, unknown, takeover, false);
    }

    CompletionStage<ExecutionReconciliation> reconcileInContext(
            SessionContext context, ToolExecutionRecord unknown,
            boolean takeover, boolean cooled) {
        requireOpen(closed);
        bindingRegistry.requireAnswerableBinding(unknown);
        context.lock();
        try {
            bindingRegistry.requireReadySessionRecord(context);
        } finally {
            context.unlock();
        }
        // Only the binding generation the execution was dispatched to,
        // reached through this process's attested lease, may answer.
        bindingRegistry.requireAnswerableBinding(unknown);
        // A Session keeps its binding generation for life, so a mismatch
        // means inconsistent records rather than something a retry fixes.
        if (!unknown.getBindingId().equals(context.binding().getBindingId())
                || unknown.getRuntimeGeneration()
                        != context.binding().getGeneration()) {
            throw conflict("runtime_execution_conflict",
                    "Runtime execution belongs to another Runtime "
                            + "generation");
        }
        if (!bindingRegistry.hasBinding(context.binding().getBindingId())) {
            // Local invalidation revokes this route even if its persistent
            // fence failed. A new observation must establish recovery evidence.
            throw evidenceUnavailable();
        }
        if (!provisioner.isUsable(context.lease())) {
            // Same retirement as every other operation on a dead lease; the
            // original Runtime is gone, so no answer can come.
            bindingRegistry.invalidateBinding(context.binding());
            throw evidenceUnavailable();
        }
        // Adoption can re-register the binding at a different endpoint than
        // the one this Session was acquired with; that stale route must not be
        // used, so the lookup fails as runtime_reconciliation_required.
        bindingRegistry.requireLiveBinding(context.binding());
        return lookupOnce(context, unknown, takeover, cooled);
    }

    private CompletionStage<ExecutionReconciliation> lookupOnce(
            SessionContext context, ToolExecutionRecord unknown,
            boolean takeover, boolean cooled) {
        String executionId = unknown.getExecutionCallId();
        if (cooled) {
            ExecutionReconciliation cached =
                    observationCooldown.cooled(executionId, unknown);
            if (cached != null) {
                return CompletableFuture.completedFuture(cached);
            }
        }
        CompletableFuture<ExecutionReconciliation> created =
                new CompletableFuture<>();
        CompletableFuture<ExecutionReconciliation> existing =
                reconciliations.putIfAbsent(executionId, created);
        if (existing != null) {
            return existing;
        }
        // Bridge into a future this service owns, so nothing the transport
        // returns or throws can leave the in-flight slot claimed, and bound
        // it so a hung transport call cannot hold the slot and every later
        // poll. Repository work afterwards relies on its own timeouts.
        CompletableFuture<Map<String, Object>> lookup =
                new CompletableFuture<>();
        try {
            CompletionStage<Map<String, Object>> query = safeStage(() ->
                    "deferred_v3".equals(unknown.getReference().get("dispatchMode"))
                            ? transport.statusV3(context.lease(), context.session(),
                                    unknown.getReference(), unknown.getLastSequence())
                                    .thenApply(RuntimeBrokerSupport::projectV3Status)
                            : transport.status(context.lease(), context.session(),
                                    unknown.getReference(), unknown.getLastSequence()));
            query
                    .whenComplete((status, error) -> {
                        if (error == null) {
                            lookup.complete(status);
                        } else {
                            lookup.completeExceptionally(error);
                        }
                    });
        } catch (RuntimeException | Error exception) {
            lookup.completeExceptionally(exception);
        }
        lookup.orTimeout(operationLeaseDuration.toMillis(),
                TimeUnit.MILLISECONDS);
        // Every caller, joined or not, maps failures in reconcileExecution.
        lookup.handle((status, error) -> {
            if (takeover) {
                requireOpen(closed);
            }
            if (error != null) {
                if (takeover && !(unwrap(error) instanceof Error)) {
                    return new ExecutionReconciliation(unknown,
                            ExecutionReconciliation.Outcome.UNRESOLVED, null);
                }
                throw new CompletionException(unwrap(error));
            }
            try {
                return absorbRuntimeStatus(unknown, status, takeover);
            } catch (RuntimeBrokerException failure) {
                if (takeover && "runtime_execution_status_invalid".equals(failure.getCode())) {
                    return new ExecutionReconciliation(unknown,
                            ExecutionReconciliation.Outcome.UNRESOLVED, null);
                }
                throw failure;
            }
        })
                .whenComplete((reconciled, error) -> {
                    // An Error is not a lookup answer: both paths above
                    // refuse to downgrade one, so the cache must not either.
                    if (cooled && (error == null
                            || !(unwrap(error) instanceof Error))) {
                        // Stamp before dropping the in-flight slot, so no
                        // sequential observer can slip between them and fan
                        // through to the worker. A failed lookup cools as
                        // UNRESOLVED: the Runtime was just unreachable, and
                        // hammering it changes nothing.
                        observationCooldown.stamp(executionId,
                                error == null ? reconciled
                                        : new ExecutionReconciliation(unknown,
                                                ExecutionReconciliation.Outcome
                                                        .UNRESOLVED, null));
                    }
                    reconciliations.remove(executionId, created);
                    if (error == null) {
                        created.complete(reconciled);
                    } else {
                        created.completeExceptionally(unwrap(error));
                    }
                });
        return created;
    }

    private static ExecutionReconciliation notUnknown(
            ToolExecutionRecord record, String runtimeState) {
        return new ExecutionReconciliation(record,
                record.getState() == ToolExecutionRecord.State.ABANDONED
                        ? ExecutionReconciliation.Outcome.ABANDONED
                        : record.isSettled() ? ExecutionReconciliation.Outcome.ALREADY_SETTLED
                                : ExecutionReconciliation.Outcome.IN_FLIGHT, runtimeState);
    }

    ExecutionReconciliation absorbRuntimeStatus(
            ToolExecutionRecord unknown, Map<String, Object> status, boolean takeover) {
        if (status == null) {
            throw invalidStatus(null);
        }
        for (Object field : status.keySet()) {
            if (!(field instanceof String)
                    || !RUNTIME_STATUS_FIELDS.contains(field)) {
                throw invalidStatus(null);
            }
        }
        Object state = status.get("state");
        if (!(state instanceof String)
                || !RUNTIME_STATUS_STATES.contains(state)
                || "settled".equals(state)
                        != status.containsKey("result")) {
            throw invalidStatus(null);
        }
        String runtimeState = (String) state;
        if (!"settled".equals(runtimeState)) {
            ToolExecutionRecord latest = executionRepository
                    .findByExecutionCallId(unknown.getExecutionCallId());
            ToolExecutionRecord current = latest == null ? unknown : latest;
            return current.getState() == ToolExecutionRecord.State.UNKNOWN
                    ? new ExecutionReconciliation(current,
                            ExecutionReconciliation.Outcome.UNRESOLVED,
                            runtimeState)
                    : notUnknown(current, runtimeState);
        }
        Map<String, Object> result;
        try {
            result = immutableMap(status.get("result"), "status result");
            // Validate before writing, so an invalid result is reported as
            // the Runtime's fault rather than as a repository failure. A
            // not_started status is accepted only as the Runtime's own
            // terminal answer; the Broker never derives it.
            unknown.resolveUnsettled(result, clock.instant());
        } catch (IllegalArgumentException | RuntimeBrokerException exception) {
            throw invalidStatus(exception);
        }
        ToolExecutionRecord current = unknown;
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current == null) {
                throw notFound("runtime_execution_not_found",
                        "Runtime execution was not found");
            }
            if (!current.needsReconciliation()
                    || !takeover && current.getState() != ToolExecutionRecord.State.UNKNOWN) {
                return notUnknown(current, runtimeState);
            }
            if (takeover) {
                requireOpen(closed);
            }
            if (!current.sameIdentity(unknown)) {
                throw conflict("runtime_execution_conflict", "Execution identity changed while reconciling");
            }
            // A racing cancel advances the version; re-read and retry.
            ToolExecutionRecord resolved = takeover
                    ? executionRepository.resolveUnsettled(current, result, clock.instant())
                    : executionRepository.resolveUnknown(current, result, clock.instant());
            if (resolved != null) {
                executionState.settleUnstartedBackgroundSiblings(
                        unknown.getExecutionCallId(), result);
                return new ExecutionReconciliation(resolved,
                        ExecutionReconciliation.Outcome.RESOLVED,
                        runtimeState);
            }
            current = executionRepository.findByExecutionCallId(
                    unknown.getExecutionCallId());
        }
        // The record is still UNKNOWN, so the next poll can try again.
        throw unavailable("runtime_execution_reconcile_failed",
                "Runtime execution changed while reconciling");
    }

    private static RuntimeBrokerException invalidStatus(Throwable cause) {
        return new RuntimeBrokerException(502,
                "runtime_execution_status_invalid",
                "Runtime execution lookup returned an invalid status", false,
                cause);
    }
}
