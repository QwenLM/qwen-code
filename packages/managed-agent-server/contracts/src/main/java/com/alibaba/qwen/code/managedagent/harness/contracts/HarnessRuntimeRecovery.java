package com.alibaba.qwen.code.managedagent.harness.contracts;

import java.util.List;
import java.util.Map;

public record HarnessRuntimeRecovery(String phase, String checkpointId, String activationId,
        List<Execution> executions, boolean unknownOutcome, boolean continuationReady, boolean cancellationReady) {
    public HarnessRuntimeRecovery { executions = List.copyOf(executions); }
    public String getPhase() { return phase; }
    public String getCheckpointId() { return checkpointId; }
    public String getActivationId() { return activationId; }
    public List<Execution> getExecutions() { return executions; }
    public boolean hasUnknownOutcome() { return unknownOutcome; }
    public boolean isContinuationReady() { return continuationReady; }
    public boolean isCancellationReady() { return cancellationReady; }

    public record Execution(String functionCallId, String toolName, String executionCallId,
            String runtimeSessionId, String progressCursor, String outcome, Map<String, Object> status) {
        public String getFunctionCallId() { return functionCallId; }
        public String getToolName() { return toolName; }
        public String getExecutionCallId() { return executionCallId; }
        public String getRuntimeSessionId() { return runtimeSessionId; }
        public String getProgressCursor() { return progressCursor; }
        public String getOutcome() { return outcome; }
        public Map<String, Object> getStatus() { return status; }
    }
}
