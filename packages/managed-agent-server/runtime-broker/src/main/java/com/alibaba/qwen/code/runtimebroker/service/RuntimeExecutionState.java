package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;

import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.MAX_CAS_ATTEMPTS;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.notFound;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

final class RuntimeExecutionState {
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final String brokerOwnerId;
    private final Duration dispatchLeaseDuration;
    private final Clock clock;

    RuntimeExecutionState(RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId,
            Duration dispatchLeaseDuration,
            Clock clock) {
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.brokerOwnerId = brokerOwnerId;
        this.dispatchLeaseDuration = dispatchLeaseDuration;
        this.clock = clock;
    }

    void settleExecution(ToolExecutionRecord original, Map<String, Object> result) {
        String executionCallId = original.getExecutionCallId();
        long dispatchGeneration = original.getDispatchGeneration();
        ToolExecutionRecord current = executionRepository
                .findByExecutionCallId(executionCallId);
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current == null || current.isTerminal()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN
                    || !ownsDispatch(current, dispatchGeneration)
                    || !current.sameIdentity(original) || !current.sameAuthorization(original)) {
                return;
            }
            ToolExecutionRecord replacement = current.withResult(result,
                    current.getLastSequence(), clock.instant());
            ToolExecutionRecord updated = executionRepository.compareAndSet(
                    current, replacement, brokerOwnerId,
                    dispatchGeneration);
            if (updated != null) {
                return;
            }
            current = executionRepository.findByExecutionCallId(
                    executionCallId);
        }
        throw conflict("runtime_execution_state_conflict",
                "Runtime execution changed while settling");
    }

    void markUnknown(ToolExecutionRecord original) {
        String executionCallId = original.getExecutionCallId();
        long dispatchGeneration = original.getDispatchGeneration();
        ToolExecutionRecord current = executionRepository
                .findByExecutionCallId(executionCallId);
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current == null || current.isTerminal()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN
                    || !ownsDispatch(current, dispatchGeneration)
                    || !current.sameIdentity(original) || !current.sameAuthorization(original)) {
                return;
            }
            ToolExecutionRecord updated = executionRepository.compareAndSet(
                    current, current.withUnknown(), brokerOwnerId,
                    dispatchGeneration);
            if (updated != null) {
                return;
            }
            current = executionRepository.findByExecutionCallId(
                    executionCallId);
        }
        fenceLapsedClaim(current);
    }

    /**
     * Once a claim has lapsed, no compare-and-set can settle the record or
     * mark it UNKNOWN; the takeover fence in {@code claimDispatch} can still
     * mark it UNKNOWN. {@code claimDispatch} judges the lease by the
     * repository's clock and never writes over a live claim, whoever holds
     * it. A DISPATCHING record is left alone, since claiming it would hold a
     * dispatch nothing here is running.
     */
    ToolExecutionRecord fenceLapsedClaim(ToolExecutionRecord current) {
        if (current == null
                || (current.getState() != ToolExecutionRecord.State.EXECUTING
                        && current.getState()
                                != ToolExecutionRecord.State
                                        .CANCEL_REQUESTED)) {
            return current;
        }
        // Only this broker's own live claim comes back; a settled or fenced
        // record, or another broker's live claim, yields null and is read
        // again.
        ToolExecutionRecord claimed = executionRepository.claimDispatch(
                current.getExecutionCallId(), brokerOwnerId,
                dispatchLeaseDuration);
        return claimed != null ? claimed : executionRepository
                .findByExecutionCallId(current.getExecutionCallId());
    }

    ToolExecutionRecord requireOwnedExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        return requireOwnership(harnessSessionId, runtimeSessionId,
                executionCallId).record();
    }

    /**
     * A terminal record comes back with the saved binding and Session rows
     * that prove its ownership; any other record comes back without them.
     */
    OwnedExecution requireOwnership(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        ToolExecutionRecord record = executionRepository
                .findByExecutionCallId(executionCallId);
        if (record == null) {
            throw notFound("runtime_execution_not_found",
                    "Runtime execution was not found");
        }
        if (!record.getHarnessSessionId().equals(harnessSessionId)
                || !record.getRuntimeSessionId().equals(runtimeSessionId)) {
            throw conflict("runtime_execution_conflict",
                    "Runtime execution belongs to another Session");
        }
        RuntimeBindingRecord binding = null;
        RuntimeSessionRecord session = null;
        if (record.isTerminal()) {
            binding = bindingRepository.findById(record.getBindingId());
            session = binding == null ? null : sessionRepository.findById(
                    binding.getRequest().getScope(), runtimeSessionId);
            if (binding == null || binding.getGeneration() != record.getRuntimeGeneration()
                    || session == null || !session.getBindingId().equals(record.getBindingId())
                    || session.getRuntimeGeneration() != record.getRuntimeGeneration()
                    || !session.getSession().getHarnessSessionId().equals(harnessSessionId)) {
                throw conflict("runtime_execution_conflict", "Saved execution ownership differs");
            }
        }
        return new OwnedExecution(record, binding, session);
    }

    /**
     * An execution whose outcome is already UNKNOWN keeps its own answer
     * when the generation that could tell more is no longer live: nothing
     * can change the record anymore, so a closed admission reads as the
     * record's UNKNOWN instead of replacing it. Any other failure, and any
     * record the caller does not own, keeps the original error.
     */
    CompletionStage<ToolExecutionRecord> unknownWhenAdmissionClosed(
            CompletionStage<ToolExecutionRecord> stage,
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        return stage.handle((record, error) -> {
            if (error == null) {
                return record;
            }
            Throwable cause = unwrap(error);
            if (cause instanceof RuntimeBrokerException exception
                    && "runtime_admission_closed".equals(exception.getCode())) {
                ToolExecutionRecord stored = executionRepository
                        .findByExecutionCallId(executionCallId);
                if (stored != null
                        && stored.getState() == ToolExecutionRecord.State.UNKNOWN
                        && stored.getHarnessSessionId().equals(harnessSessionId)
                        && stored.getRuntimeSessionId().equals(runtimeSessionId)) {
                    return stored;
                }
            }
            throw new CompletionException(cause);
        });
    }

    ToolExecutionRecord requireExecution(SessionContext context,
            String executionCallId) {
        ToolExecutionRecord record = executionRepository
                .findByExecutionCallId(executionCallId);
        if (record == null) {
            throw notFound("runtime_execution_not_found",
                    "Runtime execution was not found");
        }
        if (!record.getHarnessSessionId().equals(
                context.session().getHarnessSessionId())
                || !record.getRuntimeSessionId().equals(
                        context.session().getRuntimeSessionId())
                || !record.getBindingId().equals(
                        context.binding().getBindingId())
                || record.getRuntimeGeneration()
                        != context.binding().getGeneration()) {
            throw conflict("runtime_execution_conflict",
                    "Runtime execution belongs to another Session or "
                            + "Runtime generation");
        }
        return record;
    }

    /**
     * The Runtime proved no process ever started: without this sibling
     * settle the `:process` row would count as alive forever, and no
     * shell release could ever pass busy again (round 6). Every arm that
     * settles the invocation with that proof — the dispatch poll, and the
     * reconcile resume — calls it, so no path back to SETTLED keeps the
     * sibling PREPARED.
     */
    void settleUnstartedBackgroundSiblings(String executionCallId,
            Map<String, Object> result) {
        if (!"not_started".equals(result.get("executionStatus"))) {
            return;
        }
        ToolExecutionRecord process = executionRepository
                .findByExecutionCallId(executionCallId + ":process");
        if (process == null || process.isTerminal()) {
            return;
        }
        settleUnstartedBackgroundProcess(process, result);
    }

    void settleUnstartedBackgroundProcess(ToolExecutionRecord process,
            Map<String, Object> result) {
        Map<String, Object> settled = new LinkedHashMap<>();
        settled.put("state", "not_started");
        settled.put("executionStatus", "not_started");
        settled.put("evidence", result.get("error"));
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            ToolExecutionRecord current = executionRepository
                    .findByExecutionCallId(process.getExecutionCallId());
            if (current == null || current.isTerminal()) {
                return;
            }
            if (executionRepository.settlePrepared(current, settled,
                    clock.instant()) != null) {
                return;
            }
        }
        throw conflict("runtime_execution_state_conflict",
                "Background process could not settle with its own generation");
    }

    void settleBackgroundProcess(ToolExecutionRecord process,
            Map<String, Object> view) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("state", "exited");
        result.put("evidence", view.get("evidence"));
        Object exitCode = view.get("evidence") instanceof Map<?, ?> evidence
                ? evidence.get("exitCode") : null;
        result.put("executionStatus", Integer.valueOf(0).equals(exitCode)
                ? "success" : "error");
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            ToolExecutionRecord current = executionRepository
                    .findByExecutionCallId(process.getExecutionCallId());
            if (current == null || current.isTerminal()) {
                return;
            }
            if (executionRepository.settlePrepared(current, result,
                    clock.instant()) != null) {
                return;
            }
        }
        throw conflict("runtime_execution_state_conflict",
                "Background process could not settle with its own generation");
    }

    boolean ownsDispatch(ToolExecutionRecord current,
            long dispatchGeneration) {
        return dispatchGeneration == current.getDispatchGeneration()
                && brokerOwnerId.equals(current.getDispatchOwner());
    }

    record OwnedExecution(ToolExecutionRecord record,
            RuntimeBindingRecord binding, RuntimeSessionRecord session) {
    }
}
