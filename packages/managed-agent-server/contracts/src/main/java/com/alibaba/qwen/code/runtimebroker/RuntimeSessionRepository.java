package com.alibaba.qwen.code.runtimebroker;

/** Persistence boundary for logical Runtime Sessions. */
public interface RuntimeSessionRepository {
    public RuntimeSessionRecord findOrCreate(RuntimeSessionRecord candidate);

    public RuntimeSessionRecord findById(RuntimeScope scope, String runtimeSessionId);

    public RuntimeSessionRecord findHistorical(String tenantId, String harnessSessionId, String runtimeSessionId);

    /**
     * The Runtime Sessions among {@code runtimeSessionIds} that exist for one
     * (tenant, Harness Session), read in at most {@code ceil(ids / 100)}
     * statements. An id with no row is simply absent from the answer; an id
     * matching more than one row is refused with the same
     * {@code runtime_session_ambiguous} conflict {@link #findHistorical}
     * raises, never collapsed into one row. This lets the restart drain
     * inventory resolve the whole candidate set without one point read per
     * candidate (#13986 review R1-9).
     */
    public default java.util.List<RuntimeSessionRecord> findHistoricalByIds(String tenantId,
            String harnessSessionId, java.util.Collection<String> runtimeSessionIds) {
        throw new RuntimeBrokerException(409, "workspace_close_identity_unverified",
                "Harness Session inventory is unavailable", false);
    }

    public RuntimeSessionRecord compareAndSet(RuntimeSessionRecord expected,
            RuntimeSessionRecord replacement);

    public java.util.List<RuntimeSessionRecord> findByBinding(String bindingId, long generation,
            String afterSessionId, int limit);

    public long countActiveByBinding(String bindingId, long runtimeGeneration);

    /**
     * Active Runtime Sessions of one Harness Session in {@code (scope, runtimeSessionId)}
     * order after {@code after}. Callers re-verify the tenant and Harness Session.
     */
    public default java.util.List<RuntimeSessionRecord> findActiveByHarnessSession(String tenantId,
            String harnessSessionId, RuntimeSessionRecord after, int limit) {
        throw new RuntimeBrokerException(409, "workspace_close_identity_unverified",
                "Harness Session inventory is unavailable", false);
    }
}
