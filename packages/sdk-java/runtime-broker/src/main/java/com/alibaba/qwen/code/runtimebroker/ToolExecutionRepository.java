package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;

/** Persistence boundary for idempotent Tool execution state. */
public interface ToolExecutionRepository {
    ToolExecutionRecord findOrCreate(ToolExecutionRecord candidate);

    ToolExecutionRecord findByExecutionCallId(String executionCallId);

    ToolExecutionRecord findByIdempotencyKey(String idempotencyKey);

    /** Succeeds only while the stored record still matches {@code expected}
     * on immutable identity, dispatch claim and version, the record is
     * neither SETTLED nor UNKNOWN, and the caller presents the stored owner
     * and generation with an unexpired lease; returns null otherwise.
     * Implementations must compare and write atomically. */
    ToolExecutionRecord compareAndSet(ToolExecutionRecord expected,
            ToolExecutionRecord replacement, String owner,
            long dispatchGeneration);

    /** Taking over an expired EXECUTING or CANCEL_REQUESTED claim marks the
     * record UNKNOWN and returns null rather than a claim; an expired
     * DISPATCHING claim is re-granted at the next generation. A live claim on
     * a record that is neither SETTLED nor UNKNOWN is never written: its
     * owner gets the stored record back and any other caller gets null. For
     * a SETTLED or UNKNOWN record the call returns null. */
    ToolExecutionRecord claimDispatch(String executionCallId, String owner,
            Duration leaseDuration);

    ToolExecutionRecord renewDispatch(String executionCallId, String owner,
            long dispatchGeneration, Duration leaseDuration);

    /** Records cancellation intent without requiring the dispatch claim. A
     * PREPARED execution settles as cancelled immediately, since no
     * dispatcher exists to observe the intent. Returns null when the record
     * is missing, already settled, or no longer at expectedVersion. */
    ToolExecutionRecord requestCancel(String executionCallId,
            long expectedVersion);

    /** Settles an UNKNOWN execution through recovery reconciliation. Requires
     * the immutable identity, the current version and state UNKNOWN, but no
     * dispatch claim: a takeover-fenced record's claim is expired by
     * construction, so implementations must not add a lease predicate. */
    ToolExecutionRecord resolveUnknown(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime);

    boolean hasActiveByRuntimeSession(String runtimeSessionId);

    boolean hasActiveByBinding(String bindingId, long runtimeGeneration);
}
