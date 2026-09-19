package com.alibaba.qwen.code.runtimebroker;

/** Persistence boundary for logical Runtime Sessions. */
public interface RuntimeSessionRepository {
    RuntimeSessionRecord findOrCreate(RuntimeSessionRecord candidate);

    RuntimeSessionRecord findById(String runtimeSessionId);

    RuntimeSessionRecord compareAndSet(RuntimeSessionRecord expected,
            RuntimeSessionRecord replacement);

    long countActiveByBinding(String bindingId, long runtimeGeneration);
}
