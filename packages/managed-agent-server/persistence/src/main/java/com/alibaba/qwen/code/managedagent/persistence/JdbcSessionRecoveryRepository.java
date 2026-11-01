package com.alibaba.qwen.code.managedagent.persistence;

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
        return jdbc.query("SELECT recovery_status, recovery_detail_code"
                        + " FROM ma_session_head WHERE tenant_id = ? AND session_id = ?"
                        + " AND head_kind = 'MANAGED_SESSION'",
                (row, index) -> new HeadRecovery(row.getString("recovery_status"),
                        row.getString("recovery_detail_code")), tenantId, sessionId);
    }

    @Override
    public long nonInitialTurns(String tenantId, String sessionId) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                        + " AND (status <> 'CANCELLED' OR submission_attempted = TRUE OR harness_event_epoch IS NOT NULL)",
                Long.class, tenantId, sessionId);
    }
}
