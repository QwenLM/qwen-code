package com.alibaba.qwen.code.runtimebroker;

final class ToolExecutionRecordFixtures {
    private ToolExecutionRecordFixtures() {
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
