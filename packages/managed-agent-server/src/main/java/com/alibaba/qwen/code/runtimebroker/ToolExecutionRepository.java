package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.List;

/** Persistence boundary for idempotent Tool execution state. */
public interface ToolExecutionRepository {
    ToolExecutionRecord findOrCreate(ToolExecutionRecord candidate);

    ToolExecutionRecord findByExecutionCallId(String executionCallId);

    ToolExecutionRecord findByIdempotencyKey(String idempotencyKey);

    /** Succeeds only while the stored record still matches {@code expected}
     * on immutable identity, dispatch claim and version, the record is
     * neither terminal nor UNKNOWN, and the caller presents the stored owner
     * and generation with an unexpired lease; returns null otherwise.
     * Implementations must compare and write atomically. */
    ToolExecutionRecord compareAndSet(ToolExecutionRecord expected,
            ToolExecutionRecord replacement, String owner,
            long dispatchGeneration);

    /** Taking over an expired EXECUTING or CANCEL_REQUESTED claim marks the
     * record UNKNOWN and returns null rather than a claim; an expired
     * DISPATCHING claim is re-granted at the next generation. A live claim on
     * a record that is neither terminal nor UNKNOWN is never written: its
     * owner gets the stored record back and any other caller gets null. For
     * a terminal or UNKNOWN record the call returns null. */
    ToolExecutionRecord claimDispatch(String executionCallId, String owner,
            Duration leaseDuration);

    ToolExecutionRecord renewDispatch(String executionCallId, String owner,
            long dispatchGeneration, Duration leaseDuration);

    /** Records cancellation intent without requiring the dispatch claim. A
     * PREPARED execution settles as cancelled immediately, since no
     * dispatcher exists to observe the intent. Returns null when the record
     * is missing, already terminal, or no longer at expectedVersion. */
    ToolExecutionRecord requestCancel(String executionCallId,
            long expectedVersion);

    /** Evidence settlement of a PREPARED execution that was never
     * dispatched: the background-process row's physical end arrives
     * through the owner, never through a dispatch claim. Requires the
     * immutable identity, the current version and state PREPARED; returns
     * null when already terminal or the guard mismatches. */
    ToolExecutionRecord settlePrepared(ToolExecutionRecord expected,
            Map<String, Object> result, Instant settlementTime);

    /** Settles an UNKNOWN execution through recovery reconciliation. Requires
     * the immutable identity, the current version and state UNKNOWN, but no
     * dispatch claim: a takeover-fenced record's claim is expired by
     * construction, so implementations must not add a lease predicate. */
    ToolExecutionRecord resolveUnknown(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime);

    /** Evidence-only settlement of EXECUTING, CANCEL_REQUESTED or UNKNOWN.
     * Atomically checks identity and version, without claiming or fencing a
     * dispatch. Preserves the stored dispatch identity and cancellation intent. */
    ToolExecutionRecord resolveUnsettled(ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime);

    /** At most 100 potentially dispatched executions belonging to this exact
     * Session and binding generation, ordered by execution ID hash. The
     * exclusive cursor is an execution ID, including one already settled. */
    List<ToolExecutionRecord> findUnsettled(RuntimeSessionRecord session,
            String afterExecutionCallId, int limit);

    /** Non-terminal background-process ledger rows belonging to this exact
     * Session and binding generation, ordered by execution ID hash — the
     * same ownership fence as {@link #findUnsettled}, but found by dispatch
     * mode and non-terminal state instead of a dispatch state, because the
     * background {@code :process} row stays PREPARED between admission and
     * the process's physical end. At most 100 rows per page, and a short
     * page means the scan is exhausted; the exclusive cursor is an
     * execution ID, including one already settled. */
    List<ToolExecutionRecord> findBackgroundProcesses(RuntimeSessionRecord session,
            String afterExecutionCallId, int limit);

    /** The hold rows (a background Shell process or a Monitor watch) of
     * this Harness Session across all of its Runtime Sessions, in ANY
     * execution state, ordered by execution ID hash — the read a reloaded
     * Harness makes to restore the close's drain obligation after a restart
     * (#13930 R1-2). A hold row's terminal settle is NOT a discharge: the
     * run exiting leaves its Runtime Session unreleased, so the caller owes
     * the release-state filter — a row stops mattering only when that
     * Session's release is durably recorded. Ownership is found by harness
     * session instead of by one Runtime Session, because the held obligation
     * outlives the process that named the turn. At most 100 rows per page,
     * and a short page means the scan is exhausted; the exclusive cursor is
     * an execution ID, including one already settled. */
    List<ToolExecutionRecord> findHoldRowsByHarnessSession(String harnessSessionId,
            String afterExecutionCallId, int limit);

    /**
     * At most 100 executions in any state for this exact binding generation,
     * across all Sessions, ordered by execution ID hash. The exclusive cursor
     * is an execution ID and need not remain in any particular state.
     * A null cursor starts the scan; limit must be in [1, 100]. Cursor and
     * returned execution IDs must be well-formed text for unambiguous hashing.
     * This inventory is not a snapshot or proof that physical writers stopped.
     * Custom repositories must implement it before supporting retirement.
     */
    default List<ToolExecutionRecord> findByBinding(String bindingId,
            long runtimeGeneration, String afterExecutionCallId, int limit) {
        throw new UnsupportedOperationException(
                "Binding execution inventory is unavailable");
    }

    boolean hasActiveByRuntimeSession(String runtimeSessionId);

    boolean hasActiveByRuntimeSession(String bindingId, long runtimeGeneration,
            String runtimeSessionId);

    /** Like {@link #hasActiveByRuntimeSession(String, long, String)}, but
     * skipping the named executions: the release drain asks whether anything
     * but the Session's own background processes still runs. */
    boolean hasActiveByRuntimeSession(String bindingId, long runtimeGeneration,
            String runtimeSessionId,
            java.util.Set<String> excludingExecutionCallIds);

    /** Any SETTLED execution of this Runtime Session whose captured output
     * never proved its producer stopped: a capture other than `complete`
     * (both streams sealed by EOF) or `detached` (the live process is its
     * own `:process` row). A `partial` or `unavailable` capture may leave an
     * escaped writer in the Workspace, which the operator-recovery family
     * fences on the mount. Settled rows never change, so this stays true
     * until that recovery runs. The default fails closed like
     * findByBinding's. */
    default boolean hasUnprovenCaptureByRuntimeSession(String bindingId,
            long runtimeGeneration, String runtimeSessionId) {
        throw new UnsupportedOperationException(
                "Unproven-capture probe is unavailable");
    }

    static boolean captureStopUnproven(Map<?, ?> result) {
        return result != null && result.get("capture") instanceof Map<?, ?> capture
                && !"complete".equals(capture.get("captureStatus"))
                && !"detached".equals(capture.get("captureStatus"));
    }

    /** Any nonterminal execution still points at this binding generation.
     * UNKNOWN counts as active; terminal uncertainty is not physical stop proof. */
    boolean hasActiveByBinding(String bindingId, long runtimeGeneration);
}
