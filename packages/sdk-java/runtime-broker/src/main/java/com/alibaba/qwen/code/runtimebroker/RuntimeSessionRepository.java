package com.alibaba.qwen.code.runtimebroker;

/** Persistence boundary for logical Runtime Sessions. */
public interface RuntimeSessionRepository {
    RuntimeSessionRecord findOrCreate(RuntimeSessionRecord candidate);

    RuntimeSessionRecord findById(RuntimeScope scope, String runtimeSessionId);

    RuntimeSessionRecord compareAndSet(RuntimeSessionRecord expected,
            RuntimeSessionRecord replacement);

    java.util.List<RuntimeSessionRecord> findByBinding(String bindingId, long generation,
            String afterSessionId, int limit);

    /**
     * H4b: the newest logical Runtime Session of one Harness Session,
     * whatever binding it sits on — how the child result relay learns the
     * child Session's Runtime binding once provisioning answers.
     */
    RuntimeSessionRecord findLatestByHarnessSession(String harnessSessionId);

    long countActiveByBinding(String bindingId, long runtimeGeneration);
}
