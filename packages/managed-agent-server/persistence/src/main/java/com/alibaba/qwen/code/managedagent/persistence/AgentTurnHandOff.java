package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.time.Duration;

/** Hands an admitted Turn's dispatch lease to the Hosted Harness that pushes its events. */
final class AgentTurnHandOff {
    // The Harness renews the lease of a Turn it holds while it pushes, so
    // the cancel lane takes such a Turn back without waiting for a lapse.
    static final String HARNESS_HELD_CANCEL = "(status = 'CANCELLING' AND dispatch_owner LIKE '"
            + AgentStateStore.HARNESS_DISPATCH_OWNER_PREFIX + "%')";
    private final AgentTurnExecution turnExecution;
    private final JdbcTemplate jdbc;
    private final Clock clock;

    AgentTurnHandOff(AgentTurnExecution turnExecution, JdbcTemplate jdbc, Clock clock) {
        this.turnExecution = turnExecution;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    boolean recordAdmissionHandOff(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch, long lastEventId,
            String harnessOwner, Duration leaseDuration) {
        turnExecution.recordAdmission(tenantId, sessionId, turnId, owner, eventEpoch, lastEventId);
        long now = clock.millis();
        // A cancelling Turn stays with the dispatcher, which delivers the cancel.
        return jdbc.update("UPDATE ma_turn SET dispatch_owner = ?, dispatch_lease_until = ?,"
                        + " gmt_modified = ?, version = version + 1 WHERE tenant_id = ?"
                        + " AND session_id = ? AND turn_id = ? AND dispatch_owner = ?"
                        + " AND status = 'RUNNING'",
                harnessOwner, now + leaseDuration.toMillis(), now, tenantId, sessionId,
                turnId, owner) == 1;
    }
}
