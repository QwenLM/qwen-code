package com.alibaba.qwen.code.runtimebroker;

/**
 * One hold row of a Harness Session, narrowed to the two fields the restart
 * drain inventory reads. A full {@link ToolExecutionRecord} materialization
 * would parse the result payload and re-verify three digests for every
 * scanned row — most of them non-hold rows the caller never looks at
 * (#13986 review R1-7).
 */
public record ToolHoldRow(String executionCallId, String runtimeSessionId) {
    public ToolHoldRow {
        BrokerValues.requireId(executionCallId, "executionCallId");
        BrokerValues.requireId(runtimeSessionId, "runtimeSessionId");
    }
}
