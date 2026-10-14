package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;

final class ToolExecutionRecordFixtures {
    private ToolExecutionRecordFixtures() {
    }

    private static Map<String, Object> holdReference(
            String runtimeSessionId, String dispatchMode) {
        return Map.of("dispatchMode", dispatchMode, "sessionId",
                runtimeSessionId, "promptId", "turn", "callId", "tool",
                "argsDigest", "digest");
    }

    static ToolExecutionRecord holdRow(String executionCallId,
            String harnessSessionId, String runtimeSessionId) {
        return holdRow(executionCallId, harnessSessionId, runtimeSessionId,
                "background_v3_process");
    }

    static ToolExecutionRecord holdRow(String executionCallId,
            String harnessSessionId, String runtimeSessionId,
            String dispatchMode) {
        return ToolExecutionRecord.prepared(executionCallId,
                "key-" + executionCallId, "binding-1", 1, harnessSessionId,
                runtimeSessionId, "turn", "tool", "digest",
                holdReference(runtimeSessionId, dispatchMode));
    }

    // A snapshot that matches the stored claim and version but carries a
    // different request identity.
    static ToolExecutionRecord withIdentity(ToolExecutionRecord stored,
            String idempotencyKey, String bindingId, long runtimeGeneration,
            String harnessSessionId) {
        return ToolExecutionRecord.prepared(stored.getExecutionCallId(),
                idempotencyKey, bindingId, runtimeGeneration,
                harnessSessionId, stored.getRuntimeSessionId(),
                stored.getTurnId(), stored.getToolCallId(),
                stored.getRequestDigest(), stored.getReference())
                .withDispatch(stored.getDispatchOwner(),
                        stored.getDispatchLeaseUntil(),
                        stored.getDispatchGeneration(), stored.getState())
                .withVersion(stored.getVersion());
    }
}
