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
}
