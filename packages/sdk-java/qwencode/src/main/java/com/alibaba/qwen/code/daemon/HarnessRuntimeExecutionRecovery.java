package com.alibaba.qwen.code.daemon;

import java.util.Map;
import java.util.Objects;

/** One durable Runtime execution observed while loading a Hosted Harness. */
public final class HarnessRuntimeExecutionRecovery {
    private final String functionCallId;
    private final String toolName;
    private final String executionCallId;
    private final String runtimeSessionId;
    private final String progressCursor;
    private final String outcome;
    private final Map<String, Object> status;

    HarnessRuntimeExecutionRecovery(String functionCallId, String toolName,
            String executionCallId, String runtimeSessionId,
            String progressCursor, String outcome,
            Map<String, Object> status) {
        if ("known".equals(outcome)) {
            Objects.requireNonNull(status,
                    "status required for known outcome");
        }
        this.functionCallId = functionCallId;
        this.toolName = toolName;
        this.executionCallId = executionCallId;
        this.runtimeSessionId = runtimeSessionId;
        this.progressCursor = progressCursor;
        this.outcome = outcome;
        this.status = status;
    }

    public String getFunctionCallId() {
        return functionCallId;
    }

    public String getToolName() {
        return toolName;
    }

    public String getExecutionCallId() {
        return executionCallId;
    }

    public String getRuntimeSessionId() {
        return runtimeSessionId;
    }

    public String getProgressCursor() {
        return progressCursor;
    }

    public String getOutcome() {
        return outcome;
    }

    public Map<String, Object> getStatus() {
        return status;
    }
}
