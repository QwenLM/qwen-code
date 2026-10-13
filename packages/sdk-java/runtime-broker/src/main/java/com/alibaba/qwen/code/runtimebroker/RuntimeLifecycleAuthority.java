package com.alibaba.qwen.code.runtimebroker;

/** Request-scoped authority; never part of persisted Runtime identity. */
public record RuntimeLifecycleAuthority(String operationId, long claimGeneration) {
    public static final String OPERATION_HEADER = "X-Qwen-Lifecycle-Operation-Id";
    public static final String GENERATION_HEADER = "X-Qwen-Lifecycle-Claim-Generation";

    public RuntimeLifecycleAuthority {
        BrokerValues.requirePathSafe(BrokerValues.requireId(operationId, "operationId"), "operationId");
        if (claimGeneration < 1) {
            throw new IllegalArgumentException("Lifecycle claim generation must be positive");
        }
    }
}
