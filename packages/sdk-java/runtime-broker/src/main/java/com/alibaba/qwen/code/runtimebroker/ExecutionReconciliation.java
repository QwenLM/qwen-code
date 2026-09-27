package com.alibaba.qwen.code.runtimebroker;

/** Outcome of one evidence-only lookup of an {@code UNKNOWN} execution. */
public final class ExecutionReconciliation {
    public enum Outcome {
        /** This lookup settled the record with the Runtime's own result. */
        RESOLVED,
        /** The Runtime gave no terminal evidence; the record stays UNKNOWN. */
        UNRESOLVED,
        /** The record was already settled; polling can stop. */
        ALREADY_SETTLED,
        /**
         * The record is neither settled nor UNKNOWN, so there is nothing to
         * reconcile yet. This does not prove a dispatcher is still working
         * on it. A lapsed EXECUTING or CANCEL_REQUESTED record stays here
         * until a same-key retry or a cancel fences it as UNKNOWN, or a
         * takeover scan does; a same-key retry re-dispatches a PREPARED or
         * lapsed DISPATCHING record, which never reached the Runtime.
         */
        IN_FLIGHT
    }

    private final ToolExecutionRecord record;
    private final Outcome outcome;
    private final String runtimeState;

    ExecutionReconciliation(ToolExecutionRecord record, Outcome outcome,
            String runtimeState) {
        if (record == null || outcome == null) {
            throw new IllegalArgumentException(
                    "record and outcome are required");
        }
        this.record = record;
        this.outcome = outcome;
        this.runtimeState = runtimeState;
    }

    public ToolExecutionRecord getRecord() {
        return record;
    }

    public Outcome getOutcome() {
        return outcome;
    }

    /** The state the Runtime reported, or null when no lookup was made. */
    public String getRuntimeState() {
        return runtimeState;
    }
}
