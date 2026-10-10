package com.alibaba.qwen.code.daemon;

import java.util.List;

/** Read-only Runtime reconciliation snapshot returned by a Hosted load. */
public final class HarnessRuntimeRecovery {
    private final String phase;
    private final String checkpointId;
    private final String activationId;
    private final List<HarnessRuntimeExecutionRecovery> executions;

    HarnessRuntimeRecovery(String phase, String checkpointId,
            String activationId,
            List<HarnessRuntimeExecutionRecovery> executions) {
        this.phase = phase;
        this.checkpointId = checkpointId;
        this.activationId = activationId;
        this.executions = List.copyOf(executions);
    }

    public String getPhase() {
        return phase;
    }

    public String getCheckpointId() {
        return checkpointId;
    }

    public String getActivationId() {
        return activationId;
    }

    public List<HarnessRuntimeExecutionRecovery> getExecutions() {
        return executions;
    }

    public boolean hasUnknownOutcome() {
        return executions.stream().anyMatch(
                execution -> "unknown".equals(execution.getOutcome()));
    }

    public boolean isContinuationReady() {
        // await_agent: every wait run is observable (the relay ledger), so
        // outcomes are always known; the continue route re-enters the wait
        // and folds what the checkpoint still owes (#13708).
        if ("await_agent".equals(phase)) {
            return !executions.isEmpty() && executions.stream().allMatch(
                    execution -> "known".equals(execution.getOutcome()));
        }
        return "results_ready".equals(phase) && !executions.isEmpty()
                && executions.stream().allMatch(execution ->
                        "known".equals(execution.getOutcome())
                                && "settled".equals(
                                        execution.getStatus().get("state")));
    }

    public boolean isCancellationReady() {
        return ("await_runtime".equals(phase)
                || "await_agent".equals(phase)
                || "results_ready".equals(phase)) && !executions.isEmpty()
                && executions.stream().allMatch(execution ->
                        "known".equals(execution.getOutcome()));
    }
}
