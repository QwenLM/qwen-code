package com.alibaba.qwen.code.managedagent.repository;

import java.util.List;

public interface SessionRecoveryRepository {
    public record HeadRecovery(String state, String reasonCode,
            String journalState, String activationPhase,
            Long activationHeadRevision, Long journalRevision,
            boolean wakePending, Long wakeHeadRevision, Long wakeSealRevision,
            boolean wakeSealBackground, boolean wakeSealParkedWake) { }
    public List<HeadRecovery> heads(String tenantId, String sessionId);
    public long nonInitialTurns(String tenantId, String sessionId);

    /**
     * Whether durable work outlives the writer: an unsettled Turn, a live
     * projected Runtime execution, or an owed Hosted cleanup. A sealed head
     * alone does not distinguish a completed suspension from a load that
     * refused and closed the writer it had just acquired, so the recovery
     * view reads these obligations before it calls a sealed Session ready.
     */
    public boolean hasUnsettledWork(String tenantId, String sessionId);

    /**
     * The same question for a head whose seal certified its background holds.
     * A live projected Runtime execution and an owed Hosted cleanup are then
     * the certified background work itself, so only an unsettled Turn still
     * outlives the writer. The certificate is read at the sealed revision and
     * cleared by any acquisition, so a refused load never inherits it.
     */
    public default boolean hasUnsettledWork(String tenantId, String sessionId,
            boolean backgroundCertified) {
        return hasUnsettledWork(tenantId, sessionId);
    }

    /**
     * Whether the Turn's terminal public event was projected from the
     * Harness's journaled settlement. Only that projection carries a Harness
     * source key; the terminal events the control plane writes itself (a SQL
     * failure or cancel) carry none, so they never count as native settlement.
     */
    public boolean hasNativeTerminal(String tenantId, String sessionId, String turnId);
}
