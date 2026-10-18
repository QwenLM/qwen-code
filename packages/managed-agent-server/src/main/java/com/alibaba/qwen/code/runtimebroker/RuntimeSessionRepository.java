package com.alibaba.qwen.code.runtimebroker;

/** Persistence boundary for logical Runtime Sessions. */
public interface RuntimeSessionRepository {
    RuntimeSessionRecord findOrCreate(RuntimeSessionRecord candidate);

    RuntimeSessionRecord findById(RuntimeScope scope, String runtimeSessionId);

    RuntimeSessionRecord findHistorical(String tenantId, String harnessSessionId, String runtimeSessionId);

    RuntimeSessionRecord compareAndSet(RuntimeSessionRecord expected,
            RuntimeSessionRecord replacement);

    java.util.List<RuntimeSessionRecord> findByBinding(String bindingId, long generation,
            String afterSessionId, int limit);

    long countActiveByBinding(String bindingId, long runtimeGeneration);

    /**
     * Active Runtime Sessions of one Harness Session in {@code (scope, runtimeSessionId)}
     * order after {@code after}. Callers re-verify the tenant and Harness Session.
     */
    default java.util.List<RuntimeSessionRecord> findActiveByHarnessSession(String tenantId,
            String harnessSessionId, RuntimeSessionRecord after, int limit) {
        throw new RuntimeBrokerException(409, "workspace_close_identity_unverified",
                "Harness Session inventory is unavailable", false);
    }
}
