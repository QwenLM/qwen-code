package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.util.List;
import java.util.Map;

final class AgentActionParking {
    private final AgentStoreRows storeRows;
    private final JdbcTemplate jdbc;
    private final Clock clock;

    AgentActionParking(AgentStoreRows storeRows, JdbcTemplate jdbc, Clock clock) {
        this.storeRows = storeRows;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    boolean parkTurnForAction(String tenantId, String sessionId,
            String turnId, String owner) {
        jdbc.queryForObject("SELECT status FROM ma_session WHERE tenant_id = ? AND session_id = ?"
                + " AND session_kind = 'PUBLIC' FOR UPDATE", String.class, tenantId, sessionId);
        List<Map<String, Object>> heads = jdbc.queryForList(
                "SELECT state, activation_phase, journal_revision, wake_seal_revision,"
                        + " wake_seal_parked_prompt_id, wake_seal_parked_until,"
                        + " wake_seal_parked_approval_revision FROM ma_session_head"
                        + " WHERE tenant_id = ? AND harness_session_id = ?"
                        + " AND head_kind = 'MANAGED_SESSION' FOR UPDATE",
                tenantId, sessionId);
        if (heads.isEmpty()) {
            return false;
        }
        TurnRecord turn = storeRows.requireTurnForUpdate(tenantId, sessionId, turnId);
        long now = clock.millis();
        Map<String, Object> head = heads.getFirst();
        Number journalRevision = (Number) head.get("journal_revision");
        Number sealRevision = (Number) head.get("wake_seal_revision");
        Number parkedUntil = (Number) head.get("wake_seal_parked_until");
        Number approvalRevision = (Number) head.get("wake_seal_parked_approval_revision");
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now
                || !"RUNNING".equals(turn.status())
                || !"SEALED".equals(head.get("state"))
                || !"released".equals(head.get("activation_phase"))
                || journalRevision == null || sealRevision == null
                || journalRevision.longValue() != sealRevision.longValue()
                || parkedUntil == null
                || !turn.promptId().equals(head.get("wake_seal_parked_prompt_id"))) {
            return false;
        }
        if (approvalRevision != null) {
            long currentApproval = jdbc.queryForObject(
                    "SELECT approval_revision FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                    Long.class, tenantId, sessionId);
            if (approvalRevision.longValue() != currentApproval) {
                return false;
            }
        }
        Integer unfinished = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_operation WHERE tenant_id = ? AND session_id = ?"
                        + " AND operation_kind = 'ACTION_RESPONSE'"
                        + " AND state NOT IN ('COMPLETED', 'FAILED')",
                Integer.class, tenantId, sessionId);
        Integer requested = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_session_record WHERE tenant_id = ? AND session_id = ?"
                        + " AND prompt_id = ? AND record_kind = 'ACTION' AND state = 'requested'",
                Integer.class, tenantId, sessionId, turn.promptId());
        if (unfinished == null || unfinished > 0 || requested == null || requested == 0) {
            return false;
        }
        return jdbc.update("UPDATE ma_turn SET error_code = ?, retry_after = ?,"
                        + " dispatch_owner = NULL, dispatch_lease_until = NULL,"
                        + " gmt_modified = ?, version = version + 1"
                        + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ?"
                        + " AND dispatch_owner = ? AND dispatch_lease_until >= ?"
                        + " AND status = 'RUNNING' AND prompt_id = ?",
                AgentStateStore.HARNESS_ACTION_PARKED, parkedUntil.longValue(), now,
                tenantId, sessionId, turnId, owner, now, turn.promptId()) == 1;
    }

    static void unparkActionTurns(JdbcTemplate jdbc, String tenantId,
            String sessionId, long now) {
        jdbc.update("UPDATE ma_turn SET error_code = NULL, retry_after = NULL,"
                        + " gmt_modified = ?, version = version + 1"
                        + " WHERE tenant_id = ? AND session_id = ? AND error_code = ?",
                now, tenantId, sessionId, AgentStateStore.HARNESS_ACTION_PARKED);
    }

    static void unparkForApprovalChange(JdbcTemplate jdbc, String tenantId,
            String sessionId, long now) {
        unparkActionTurns(jdbc, tenantId, sessionId, now);
        // A wake-started Turn has no Turn row to unpark. Make its head due
        // now so the wake-recovery scan can claim it on the next pass.
        jdbc.update("UPDATE ma_session_head SET wake_retry_at = ?, gmt_modified = ?"
                        + " WHERE tenant_id = ? AND harness_session_id = ?"
                        + " AND head_kind = 'MANAGED_SESSION' AND wake_seal_parked_owner = 'wake'"
                        + " AND (wake_retry_at IS NULL OR wake_retry_at > ?)",
                now, now, tenantId, sessionId, now);
    }

    /**
     * Whether the head carries an intact Action park certificate and the
     * parked Turn is the Session's only live work: no other prompt holds a
     * requested Action, and the sole active Turn row is the parked one, or,
     * for a wake-started Turn, which has no row, there is none. Only such a
     * certificate may exempt an approval change from the busy gates.
     */
    static boolean certificateMatches(JdbcTemplate jdbc, String tenantId,
            String sessionId) {
        List<Map<String, Object>> heads = jdbc.queryForList(
                "SELECT state, activation_phase, journal_revision, wake_seal_revision,"
                        + " wake_seal_parked_prompt_id, wake_seal_parked_until,"
                        + " wake_seal_parked_approval_revision, wake_seal_parked_owner FROM ma_session_head"
                        + " WHERE tenant_id = ? AND harness_session_id = ?"
                        + " AND head_kind = 'MANAGED_SESSION'",
                tenantId, sessionId);
        if (heads.size() != 1) {
            return false;
        }
        Map<String, Object> head = heads.getFirst();
        Number journalRevision = (Number) head.get("journal_revision");
        Number sealRevision = (Number) head.get("wake_seal_revision");
        Number parkedUntil = (Number) head.get("wake_seal_parked_until");
        Number approvalRevision = (Number) head.get("wake_seal_parked_approval_revision");
        Object parkedPromptId = head.get("wake_seal_parked_prompt_id");
        if (!"SEALED".equals(head.get("state"))
                || !"released".equals(head.get("activation_phase"))
                || journalRevision == null || sealRevision == null
                || journalRevision.longValue() != sealRevision.longValue()
                || parkedPromptId == null || parkedUntil == null) {
            return false;
        }
        if (approvalRevision != null) {
            Number currentApproval = jdbc.queryForObject(
                    "SELECT approval_revision FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                    Number.class, tenantId, sessionId);
            if (currentApproval == null
                    || approvalRevision.longValue() != currentApproval.longValue()) {
                return false;
            }
        }
        Integer activeTurns = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " AND status IN ('ACCEPTED', 'RUNNING', 'CANCELLING')",
                Integer.class, tenantId, sessionId);
        Integer foreignRequested = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_session_record WHERE tenant_id = ? AND session_id = ?"
                        + " AND record_kind = 'ACTION' AND state = 'requested' AND prompt_id <> ?",
                Integer.class, tenantId, sessionId, parkedPromptId);
        if (foreignRequested == null || foreignRequested != 0) {
            return false;
        }
        if ("wake".equals(head.get("wake_seal_parked_owner"))) {
            return activeTurns != null && activeTurns == 0;
        }
        Integer parkedTurns = jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " AND status = 'RUNNING' AND error_code = ? AND prompt_id = ?"
                        + " AND dispatch_owner IS NULL",
                Integer.class, tenantId, sessionId,
                AgentStateStore.HARNESS_ACTION_PARKED, parkedPromptId);
        return activeTurns != null && activeTurns == 1
                && parkedTurns != null && parkedTurns == 1;
    }
}
