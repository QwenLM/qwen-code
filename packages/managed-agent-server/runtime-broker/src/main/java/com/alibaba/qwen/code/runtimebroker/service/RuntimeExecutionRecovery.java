package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedHoldFamily;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.failed;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.invalid;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.notFound;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.referenceString;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;

final class RuntimeExecutionRecovery {
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeExecutionState executionState;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final RuntimeTransport transport;
    private final RuntimeExecutionReconciler executionReconciler;
    private final AtomicBoolean closed;

    RuntimeExecutionRecovery(RuntimeBindingRegistry bindingRegistry,
            RuntimeExecutionState executionState,
            ToolExecutionRepository executionRepository,
            RuntimeSessionRepository sessionRepository,
            RuntimeTransport transport,
            RuntimeExecutionReconciler executionReconciler,
            AtomicBoolean closed) {
        this.bindingRegistry = bindingRegistry;
        this.executionState = executionState;
        this.executionRepository = executionRepository;
        this.sessionRepository = sessionRepository;
        this.transport = transport;
        this.executionReconciler = executionReconciler;
        this.closed = closed;
    }

    /**
     * Asks the physical owner of a background process for status. An
     * exited answer settles the process row with that evidence; anything
     * else keeps the row active and its hold, exactly the wedge semantics
     * — a status that cannot be proven never becomes a claimed end.
     */
    CompletionStage<ToolExecutionRecord> observeBackgroundProcess(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen(closed);
        String invocationId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    ToolExecutionRecord invocation = executionState.requireExecution(context, invocationId);
                    ToolExecutionRecord process = executionState.requireExecution(context, invocationId + ":process");
                    return observeProcessRow(context, invocation, process);
                });
    }

    /**
     * H4f: the public task cancel's stop of one background Shell or
     * Monitor watch, named by the call that started it inside the Harness
     * Session that owns the task. It runs the drain sweep's status → stop
     * → status for that one hold row, so only the worker's exit evidence
     * settles the row, and the worker answers a stop only after the
     * stop-marked finalize that settles the task's record has returned.
     * It runs unfenced, like a client Monitor control: the hold row itself
     * keeps the Runtime Session from releasing while the process may run,
     * so a racing close's drain is never refused busy because of it.
     */
    CompletionStage<ToolExecutionRecord> stopBackgroundProcess(
            String tenantId, String harnessSessionId,
            String executionCallId) {
        requireOpen(closed);
        String invocationId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        ToolExecutionRecord row = executionRepository.findByExecutionCallId(
                invocationId + ":process");
        if (row == null || !row.getHarnessSessionId().equals(harnessSessionId)) {
            return failed(notFound("runtime_execution_not_found",
                    "The background process was not found"));
        }
        return bindingRegistry.requireReadySession(harnessSessionId, row.getRuntimeSessionId())
                .thenCompose(context -> {
                    if (!context.session().getScope().getTenantId()
                            .equals(tenantId)) {
                        throw notFound("runtime_execution_not_found",
                                "The background process was not found");
                    }
                    ToolExecutionRecord invocation = executionState.requireExecution(context,
                            invocationId);
                    ToolExecutionRecord process = executionState.requireExecution(context,
                            row.getExecutionCallId());
                    return observeScannedProcessRow(context, invocation,
                            process)
                            .thenCompose(current -> current.isTerminal()
                                    ? CompletableFuture.completedFuture(
                                            current)
                                    : controlProcessRow(context, invocation,
                                            current, stopKind(current),
                                            false))
                            .thenCompose(current -> current.isTerminal()
                                    ? CompletableFuture.completedFuture(
                                            current)
                                    : observeScannedProcessRow(context,
                                            invocation, current));
                });
    }

    CompletionStage<SessionContext> scanExecutions(SessionContext context,
            RuntimeSessionRecord session, String afterExecutionCallId) {
        requireOpen(closed);
        List<ToolExecutionRecord> batch = executionRepository.findUnsettled(
                session, afterExecutionCallId, 100);
        CompletionStage<Void> scanned = CompletableFuture.completedFuture(null);
        for (ToolExecutionRecord candidate : batch) {
            // A timed-out lookup completes on the JVM's timeout thread;
            // the next repository read must not block that thread.
            scanned = scanned.thenComposeAsync(ignored -> {
                requireOpen(closed);
                ToolExecutionRecord current = executionState.requireExecution(context, candidate.getExecutionCallId());
                return current.needsReconciliation()
                        ? executionReconciler.reconcileInContext(context, current, true).thenApply(result -> null)
                        : CompletableFuture.completedFuture(null);
            });
        }
        // Yield between pages even when every status completes synchronously.
        return scanned.thenComposeAsync(ignored -> {
            if (batch.size() < 100) {
                observeScannedBackgroundProcesses(context);
                return CompletableFuture.completedFuture(context);
            }
            return scanExecutions(context, session,
                    batch.get(batch.size() - 1).getExecutionCallId());
        });
    }

    /**
     * A background `:process` row stays PREPARED for the process's life, so
     * the reconcile filter above never reaches it — after the last page,
     * observe each live one from durable evidence: a provable exit settles
     * the row here, and anything else keeps it holding. Every observation
     * is fire-and-forget (an acquire never waits on it) and per-row
     * isolated (a store fault or a broken control must never fail an
     * acquire); the release sweep or a later scan asks again. The release
     * sweep's per-row prelude in {@code settleUnprovenBackgroundRows} is
     * the same shape, kept separate because it owns the in-memory index
     * and the status→terminate→status follow-up.
     */
    private void observeScannedBackgroundProcesses(SessionContext context) {
        List<ToolExecutionRecord> rows;
        try {
            rows = durableBackgroundProcessRows(context);
        } catch (RuntimeException listing) {
            return;
        }
        for (ToolExecutionRecord row : rows) {
            if (row.isTerminal()) {
                continue;
            }
            ToolExecutionRecord invocation;
            try {
                invocation = executionState.requireExecution(context, referenceString(
                        row.getReference(), "processOf"));
            } catch (RuntimeException missing) {
                continue;
            }
            ToolExecutionRecord parent = invocation;
            CompletableFuture.completedFuture(null)
                    .thenComposeAsync(ignored -> observeScannedProcessRow(
                            context, parent, row))
                    .exceptionally(failure -> null);
        }
    }

    private CompletionStage<ToolExecutionRecord> observeProcessRow(
            SessionContext context, ToolExecutionRecord invocation,
            ToolExecutionRecord process) {
        return controlProcessRow(context, invocation, process,
                statusKind(process), true);
    }

    /**
     * The scan's read-only maintenance ask runs unfenced: it must not hold
     * `activeControls` past the sweep's own proof, or a release that settled
     * every row would still refuse `runtime_session_busy` solely for the
     * outstanding status answer (#13830 review).
     */
    private CompletionStage<ToolExecutionRecord> observeScannedProcessRow(
            SessionContext context, ToolExecutionRecord invocation,
            ToolExecutionRecord process) {
        return controlProcessRow(context, invocation, process,
                statusKind(process), false);
    }

    /**
     * A hold row's family names its maintenance kinds: the background Shell
     * rides {@code shell-status}/{@code shell-terminate}, the Monitor watch
     * {@code monitor-status}/{@code monitor-stop}. The sweep and the scan
     * only ever touch hold rows, so the family is always present.
     */
    private static String statusKind(ToolExecutionRecord process) {
        ManagedHoldFamily family = ManagedHoldFamily.of(process);
        if (family == null) {
            throw invalid("runtime_control_operation_invalid",
                    "A hold row's dispatch mode is required");
        }
        return family.statusKind();
    }

    private static String stopKind(ToolExecutionRecord process) {
        ManagedHoldFamily family = ManagedHoldFamily.of(process);
        if (family == null) {
            throw invalid("runtime_control_operation_invalid",
                    "A hold row's dispatch mode is required");
        }
        return family.stopKind();
    }

    /**
     * One maintenance operation against a background process's physical
     * owner. An `exited` answer settles the row with that evidence —
     * terminal for both the status read and the stop the release asks
     * for, whose answer carries the same receipt view; anything else
     * keeps the row active and holding, exactly the wedge semantics.
     */
    private CompletionStage<ToolExecutionRecord> controlProcessRow(
            SessionContext context, ToolExecutionRecord invocation,
            ToolExecutionRecord process, String kind) {
        return controlProcessRow(context, invocation, process, kind, true);
    }

    private CompletionStage<ToolExecutionRecord> controlProcessRow(
            SessionContext context, ToolExecutionRecord invocation,
            ToolExecutionRecord process, String kind, boolean fenced) {
        if (process.isTerminal()) {
            return CompletableFuture.completedFuture(process);
        }
        Map<String, Object> operation = new LinkedHashMap<>();
        operation.put("kind", kind);
        operation.put("sessionKey", Map.of(
                "tenantId", context.session().getScope().getTenantId(),
                "workspaceId", context.session().getScope().getWorkspaceId(),
                "sessionId", context.session().getHarnessSessionId()));
        operation.put("operationId", process.getExecutionCallId());
        operation.put("targetOperationId",
                referenceString(invocation.getReference(), "callId"));
        if (fenced) {
            context.beginControl();
        }
        return mapFailure(safeStage(() -> {
            bindingRegistry.requireUsableLease(context);
            return transport.control(context.lease(), context.session(),
                    operation);
        }), "runtime_shell_status_failed", "Shell status lookup failed")
            .thenApply(view -> {
                if (!(view instanceof Map<?, ?> answer)
                        || !"exited".equals(answer.get("state"))) {
                    return process;
                }
                executionState.settleBackgroundProcess(process, (Map<String, Object>) view);
                ToolExecutionRecord current = executionRepository
                        .findByExecutionCallId(process.getExecutionCallId());
                return current == null ? process : current;
            })
            .whenComplete((ignored, error) -> {
                if (fenced) {
                    context.endControl();
                }
            });
    }

    /**
     * Before a release computes its busy check, every hold row this Broker
     * admitted for the Session asks its physical owner once: a proven exit
     * settles the row here, and anything else simply keeps it — the busy or
     * held answer behind it then stands on what is actually still running.
     * A failed lookup moves on, because busy remains the accurate answer
     * for what could not be proven. Only a drain issues each live row's
     * stop; a routine release observes and holds.
     */
    CompletionStage<Void> settleUnprovenBackgroundRows(
            SessionContext context, boolean drain) {
        CompletionStage<Void> chain = CompletableFuture.completedFuture(null);
        List<String> processIds;
        List<ToolExecutionRecord> durable = durableBackgroundProcessRows(
                context);
        context.lock();
        try {
            for (ToolExecutionRecord row : durable) {
                context.backgroundProcesses().add(row.getExecutionCallId());
            }
            processIds = new ArrayList<>(context.backgroundProcesses());
        } finally {
            context.unlock();
        }
        for (String processId : processIds) {
            ToolExecutionRecord row = executionRepository
                    .findByExecutionCallId(processId);
            if (row == null || row.isTerminal()) {
                context.lock();
                try {
                    context.backgroundProcesses().remove(processId);
                } finally {
                    context.unlock();
                }
                continue;
            }
            ToolExecutionRecord invocation;
            try {
                invocation = executionState.requireExecution(context,
                        referenceString(row.getReference(), "processOf"));
            } catch (RuntimeException notOurs) {
                continue;
            }
            // Status first. A drain gives a row the owner still counts
            // running one stop it must prove — an unproven stop keeps the
            // hold, and the busy answer behind it stays accurate. A routine
            // release stops nothing: the run holds its Runtime for as long
            // as it needs it, and the release answers held instead.
            chain = chain.thenCompose(ignored -> observeProcessRow(
                    context, invocation, row)
                    .thenCompose(current -> !drain || current.isTerminal()
                            ? CompletableFuture.completedFuture(current)
                            : controlProcessRow(context, invocation, current,
                                    stopKind(current)))
                    .thenCompose(current -> !drain || current.isTerminal()
                            ? CompletableFuture.completedFuture(current)
                            : observeProcessRow(context, invocation, current))
                    .thenApply(current -> {
                        if (current.isTerminal()) {
                            context.lock();
                            try {
                                context.backgroundProcesses().remove(processId);
                            } finally {
                                context.unlock();
                            }
                        }
                        return (Void) null;
                    })
                    .exceptionally(failure -> null));
        }
        return chain;
    }

    /**
     * The durable ledger knows every background process this Session was
     * ever admitted for; the in-memory index only knows the ones this
     * Broker process admitted itself. Without the backfill a fresh context
     * — every release path after a Broker restart — sweeps nothing, and
     * the non-terminal `:process` row answers busy forever. The scan stays
     * inside the repository's Session-and-generation fence, so a stale
     * cross-generation row never enters the sweep or the busy-check
     * exclusion set.
     */
    private List<ToolExecutionRecord> durableBackgroundProcessRows(
            SessionContext context) {
        RuntimeSessionRecord session = sessionRepository.findById(
                context.session().getScope(),
                context.session().getRuntimeSessionId());
        if (session == null) {
            return List.of();
        }
        List<ToolExecutionRecord> rows = new ArrayList<>();
        String after = null;
        for (;;) {
            List<ToolExecutionRecord> batch = executionRepository
                    .findBackgroundProcesses(session, after, 100);
            if (batch.isEmpty()) {
                return rows;
            }
            rows.addAll(batch);
            if (batch.size() < 100) {
                return rows;
            }
            after = batch.get(batch.size() - 1).getExecutionCallId();
        }
    }
}
