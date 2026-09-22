package com.alibaba.qwen.code.runtimebroker;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Durable identity, ownership, and result for one Tool execution. */
public final class ToolExecutionRecord {
    private static final Set<String> EXECUTION_STATUSES = Set.of(
            "not_started", "success", "error", "cancelled");

    public enum State {
        PREPARED,
        DISPATCHING,
        EXECUTING,
        CANCEL_REQUESTED,
        SETTLED,
        UNKNOWN
    }

    private final String executionCallId;
    private final String idempotencyKey;
    private final String bindingId;
    private final long runtimeGeneration;
    private final String harnessSessionId;
    private final String runtimeSessionId;
    private final String turnId;
    private final String toolCallId;
    private final String requestDigest;
    private final Map<String, Object> reference;
    private final State state;
    private final String executionStatus;
    private final Map<String, Object> result;
    private final long lastSequence;
    private final boolean cancelRequested;
    private final String dispatchOwner;
    private final Instant dispatchLeaseUntil;
    private final long dispatchGeneration;
    private final long version;
    private final Instant settledAt;

    public ToolExecutionRecord(String executionCallId, String idempotencyKey,
            String bindingId, long runtimeGeneration,
            String harnessSessionId, String runtimeSessionId, String turnId,
            String toolCallId, String requestDigest,
            Map<String, Object> reference, State state,
            String executionStatus, Map<String, Object> result,
            long lastSequence, boolean cancelRequested,
            String dispatchOwner, Instant dispatchLeaseUntil,
            long dispatchGeneration, long version, Instant settledAt) {
        this.executionCallId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        this.idempotencyKey = BrokerValues.requireId(idempotencyKey,
                "idempotencyKey");
        this.bindingId = BrokerValues.requireId(bindingId, "bindingId");
        if (runtimeGeneration <= 0) {
            throw new IllegalArgumentException(
                    "runtimeGeneration must be positive");
        }
        this.harnessSessionId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        this.runtimeSessionId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        this.turnId = BrokerValues.requireId(turnId, "turnId");
        this.toolCallId = BrokerValues.requireId(toolCallId, "toolCallId");
        this.requestDigest = BrokerValues.requireId(requestDigest,
                "requestDigest");
        if (reference == null || state == null) {
            throw new IllegalArgumentException(
                    "reference and state are required");
        }
        if (!runtimeSessionId.equals(reference.get("sessionId"))
                || !turnId.equals(reference.get("promptId"))
                || !toolCallId.equals(reference.get("callId"))
                || !requestDigest.equals(reference.get("argsDigest"))) {
            throw new IllegalArgumentException(
                    "reference identity does not match execution identity");
        }
        if (executionStatus != null
                && !EXECUTION_STATUSES.contains(executionStatus)) {
            throw new IllegalArgumentException("executionStatus is invalid");
        }
        if (lastSequence < 0 || dispatchGeneration < 0 || version < 0) {
            throw new IllegalArgumentException(
                    "sequence, generation, and version must be non-negative");
        }
        if ((dispatchOwner == null) != (dispatchLeaseUntil == null)) {
            throw new IllegalArgumentException(
                    "dispatch owner and lease must be set together");
        }
        if (state == State.CANCEL_REQUESTED && !cancelRequested) {
            throw new IllegalArgumentException(
                    "CANCEL_REQUESTED requires cancelRequested");
        }
        if (dispatchOwner != null) {
            BrokerValues.requireId(dispatchOwner, "dispatchOwner");
            if (dispatchGeneration <= 0) {
                throw new IllegalArgumentException(
                        "claimed dispatch generation must be positive");
            }
        }
        if (state == State.SETTLED
                && (executionStatus == null || result == null
                        || settledAt == null)) {
            throw new IllegalArgumentException(
                    "settled execution requires status, result, and time");
        }
        if (state == State.SETTLED
                && !executionStatus.equals(result.get("executionStatus"))) {
            throw new IllegalArgumentException(
                    "result executionStatus does not match record status");
        }
        if (state != State.SETTLED
                && (executionStatus != null || result != null
                        || settledAt != null)) {
            throw new IllegalArgumentException(
                    "non-settled execution must not have a result");
        }
        this.runtimeGeneration = runtimeGeneration;
        this.reference = BrokerValues.immutableMap(reference);
        this.state = state;
        this.executionStatus = executionStatus;
        this.result = result == null ? null
                : BrokerValues.immutableMap(result);
        this.lastSequence = lastSequence;
        this.cancelRequested = cancelRequested;
        this.dispatchOwner = dispatchOwner;
        this.dispatchLeaseUntil = dispatchLeaseUntil;
        this.dispatchGeneration = dispatchGeneration;
        this.version = version;
        this.settledAt = settledAt;
    }

    public static ToolExecutionRecord prepared(String executionCallId,
            String idempotencyKey, String bindingId, long runtimeGeneration,
            String harnessSessionId, String runtimeSessionId, String turnId,
            String toolCallId, String requestDigest,
            Map<String, Object> reference) {
        return new ToolExecutionRecord(executionCallId, idempotencyKey,
                bindingId, runtimeGeneration, harnessSessionId,
                runtimeSessionId, turnId, toolCallId, requestDigest,
                reference, State.PREPARED, null, null, 0, false, null, null,
                0, 0, null);
    }

    public String getExecutionCallId() {
        return executionCallId;
    }

    public String getIdempotencyKey() {
        return idempotencyKey;
    }

    public String getBindingId() {
        return bindingId;
    }

    public long getRuntimeGeneration() {
        return runtimeGeneration;
    }

    public String getHarnessSessionId() {
        return harnessSessionId;
    }

    public String getRuntimeSessionId() {
        return runtimeSessionId;
    }

    public String getTurnId() {
        return turnId;
    }

    public String getToolCallId() {
        return toolCallId;
    }

    public String getRequestDigest() {
        return requestDigest;
    }

    public Map<String, Object> getReference() {
        return reference;
    }

    public State getState() {
        return state;
    }

    public String getExecutionStatus() {
        return executionStatus;
    }

    public Map<String, Object> getResult() {
        return result;
    }

    public long getLastSequence() {
        return lastSequence;
    }

    public boolean isCancelRequested() {
        return cancelRequested;
    }

    public String getDispatchOwner() {
        return dispatchOwner;
    }

    public Instant getDispatchLeaseUntil() {
        return dispatchLeaseUntil;
    }

    public long getDispatchGeneration() {
        return dispatchGeneration;
    }

    public long getVersion() {
        return version;
    }

    public Instant getSettledAt() {
        return settledAt;
    }

    public boolean isSettled() {
        return state == State.SETTLED;
    }

    public ToolExecutionRecord withState(State nextState,
            boolean requested) {
        return copy(nextState, null, null, lastSequence, requested,
                dispatchOwner, dispatchLeaseUntil, dispatchGeneration,
                version, null);
    }

    public ToolExecutionRecord withResult(Map<String, Object> nextResult,
            long sequence, Instant completionTime) {
        if (nextResult == null) {
            throw new IllegalArgumentException("result is required");
        }
        Object status = nextResult.get("executionStatus");
        if (!(status instanceof String)) {
            throw new IllegalArgumentException(
                    "result executionStatus is required");
        }
        if (sequence < lastSequence) {
            throw new IllegalArgumentException(
                    "result sequence must not move backwards");
        }
        return copy(State.SETTLED, (String) status, nextResult, sequence,
                cancelRequested, dispatchOwner, dispatchLeaseUntil,
                dispatchGeneration, version, completionTime);
    }

    public ToolExecutionRecord withUnknown() {
        // The last claim stays on the record so recovery can attest which
        // dispatcher and lease may still be executing physically.
        return copy(State.UNKNOWN, null, null, lastSequence,
                cancelRequested, dispatchOwner, dispatchLeaseUntil,
                dispatchGeneration, version, null);
    }

    public ToolExecutionRecord resolveUnknown(
            Map<String, Object> resolutionResult, Instant resolutionTime) {
        if (state != State.UNKNOWN) {
            throw new IllegalStateException("execution is not unknown");
        }
        if (resolutionTime == null) {
            throw new IllegalArgumentException("resolutionTime is required");
        }
        Object status = resolutionResult == null ? null
                : resolutionResult.get("executionStatus");
        if (!(status instanceof String)) {
            throw new IllegalArgumentException(
                    "resolution executionStatus is required");
        }
        return copy(State.SETTLED, (String) status, resolutionResult,
                lastSequence, cancelRequested, dispatchOwner,
                dispatchLeaseUntil, dispatchGeneration, version,
                resolutionTime);
    }

    ToolExecutionRecord withDispatch(String owner, Instant leaseUntil,
            long nextDispatchGeneration, State nextState) {
        return copy(nextState, executionStatus, result, lastSequence,
                cancelRequested, owner, leaseUntil, nextDispatchGeneration,
                version, settledAt);
    }

    ToolExecutionRecord withVersion(long nextVersion) {
        return copy(state, executionStatus, result, lastSequence,
                cancelRequested, dispatchOwner, dispatchLeaseUntil,
                dispatchGeneration, nextVersion, settledAt);
    }

    boolean sameIdentity(ToolExecutionRecord other) {
        return other != null
                && executionCallId.equals(other.executionCallId)
                && idempotencyKey.equals(other.idempotencyKey)
                && bindingId.equals(other.bindingId)
                && runtimeGeneration == other.runtimeGeneration
                && harnessSessionId.equals(other.harnessSessionId)
                && runtimeSessionId.equals(other.runtimeSessionId)
                && turnId.equals(other.turnId)
                && toolCallId.equals(other.toolCallId)
                && requestDigest.equals(other.requestDigest)
                && BrokerValues.sameJsonMap(reference, other.reference);
    }

    boolean sameDispatch(ToolExecutionRecord other) {
        return other != null
                && Objects.equals(dispatchOwner, other.dispatchOwner)
                && Objects.equals(dispatchLeaseUntil,
                        other.dispatchLeaseUntil)
                && dispatchGeneration == other.dispatchGeneration;
    }

    boolean hasLiveDispatchAt(Instant now) {
        return dispatchOwner != null && dispatchLeaseUntil.isAfter(now);
    }

    public boolean sameRequest(ToolExecutionRecord other) {
        return other != null
                && idempotencyKey.equals(other.idempotencyKey)
                && bindingId.equals(other.bindingId)
                && runtimeGeneration == other.runtimeGeneration
                && harnessSessionId.equals(other.harnessSessionId)
                && runtimeSessionId.equals(other.runtimeSessionId)
                && turnId.equals(other.turnId)
                && toolCallId.equals(other.toolCallId)
                && requestDigest.equals(other.requestDigest)
                && BrokerValues.sameJsonMap(reference, other.reference);
    }

    private ToolExecutionRecord copy(State nextState, String nextStatus,
            Map<String, Object> nextResult, long sequence, boolean requested,
            String owner, Instant leaseUntil, long nextDispatchGeneration,
            long nextVersion, Instant completionTime) {
        return new ToolExecutionRecord(executionCallId, idempotencyKey,
                bindingId, runtimeGeneration, harnessSessionId,
                runtimeSessionId, turnId, toolCallId, requestDigest,
                reference, nextState, nextStatus, nextResult, sequence,
                requested, owner, leaseUntil, nextDispatchGeneration,
                nextVersion, completionTime);
    }
}
