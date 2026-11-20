package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.SessionRecoveryRepository;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public class JdbcSessionRecoveryRepository implements SessionRecoveryRepository {
    private final JdbcTemplate jdbc;
    public JdbcSessionRecoveryRepository(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc) { this.jdbc = jdbc; }

    @Override
    public List<HeadRecovery> heads(String tenantId, String sessionId) {
        return jdbc.query("SELECT recovery_status, recovery_detail_code, state,"
                        + " activation_phase, activation_head_revision, journal_revision,"
                        + " is_wake_pending, wake_head_revision, wake_seal_revision"
                        + " FROM ma_session_head WHERE tenant_id = ? AND session_id = ?"
                        + " AND head_kind = 'MANAGED_SESSION'",
                (row, index) -> new HeadRecovery(row.getString("recovery_status"),
                        row.getString("recovery_detail_code"),
                        row.getString("state"),
                        row.getString("activation_phase"),
                        row.getObject("activation_head_revision", Long.class),
                        row.getObject("journal_revision", Long.class),
                        row.getInt("is_wake_pending") != 0,
                        row.getObject("wake_head_revision", Long.class),
                        row.getObject("wake_seal_revision", Long.class)), tenantId, sessionId);
    }

    @Override
    public boolean hasUnsettledWork(String tenantId, String sessionId) {
        // The cleanup arm is the debt scanner's own predicate: a REFERENCED
        // HOSTED_CLEANUP ref is an owed release whoever holds the writer.
        // runtime_state is non-null only while a projected run's Runtime
        // execution is live, so it names unsettled MCP, Hook, extension,
        // child and Monitor work without reading a record body.
        // The record and ref arms lead with session_scope_key because every
        // index on those tables does; the raw (tenant_id, session_id) pair
        // covers none of them, and inspect() projects this onto every
        // ordinary read of a suspended Session.
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, sessionId);
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS(SELECT 1 FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " AND status IN ('ACCEPTED', 'RUNNING', 'CANCELLING'))"
                        + " OR EXISTS(SELECT 1 FROM ma_session_record WHERE session_scope_key = ?"
                        + " AND record_kind = 'DOMAIN' AND runtime_state IS NOT NULL)"
                        + " OR EXISTS(SELECT 1 FROM ma_resource_ref r JOIN ma_resource m"
                        + " ON m.resource_key = r.resource_key WHERE r.session_scope_key = ?"
                        + " AND r.owner_kind = 'HOSTED_CLEANUP' AND m.state = 'REFERENCED')",
                Boolean.class, tenantId, sessionId, scope, scope));
    }

    @Override
    public boolean hasNativeTerminal(String tenantId, String sessionId, String turnId) {
        return Boolean.TRUE.equals(jdbc.queryForObject(
                "SELECT EXISTS(SELECT 1 FROM ma_public_event WHERE tenant_id = ? AND session_id = ?"
                        + " AND turn_id = ? AND stream_kind = 'SESSION' AND is_terminal = 1"
                        + " AND source_key IS NOT NULL)",
                Boolean.class, tenantId, sessionId, turnId));
    }

    @Override
    public long nonInitialTurns(String tenantId, String sessionId) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " AND (status <> 'CANCELLED' OR is_submission_attempted = TRUE OR harness_event_epoch IS NOT NULL)",
                Long.class, tenantId, sessionId);
    }
}
