package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;

public interface NativeCsiExecutionRepository {
    public ToolExecutionRecord prepareCsiExecution(
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions,
            RuntimeBindingRecord hint,
            ToolExecutionRecord candidate,
            byte[] input,
            byte[] definition);

    public Map<String, Object> readCsiBatch(
            RuntimeSessionRepository sessions, ToolExecutionRepository executions,
            RuntimeBindingRecord hint, String promptId, String batchId);

    public Map<String, Object> readCsiBatch(
            RuntimeSessionRepository sessions,
            ToolExecutionRepository executions,
            RuntimeBindingRecord hint,
            String promptId,
            String batchId, Map<String, Object> recoveryOwner);
}
