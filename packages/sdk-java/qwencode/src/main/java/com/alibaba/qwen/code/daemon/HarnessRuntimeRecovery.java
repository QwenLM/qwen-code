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
        return "results_ready".equals(phase) && !hasUnknownOutcome();
    }
}
