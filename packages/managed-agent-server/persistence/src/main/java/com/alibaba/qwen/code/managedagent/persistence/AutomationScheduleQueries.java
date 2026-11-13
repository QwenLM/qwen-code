package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.ScheduleCursor;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.SchedulePage;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.ScheduleRow;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.util.List;

final class AutomationScheduleQueries {
    private AutomationScheduleQueries() {
    }

    static SchedulePage listReadable(JdbcTemplate jdbc, RowMapper<ScheduleRow> mapper,
            String tenantId, String actorId, ScheduleCursor cursor, int limit) {
        if (actorId == null || actorId.isEmpty()) {
            return new SchedulePage(List.of(), false);
        }
        byte[] actorKey;
        try {
            actorKey = ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            return new SchedulePage(List.of(), false);
        }
        String select =
                "WITH RECURSIVE readable_workspace (tenant_identity, workspace_identity) AS ( SELECT CONCAT(w.tenant_id, '!'), CONCAT(w.workspace_id, '!') FROM ma_workspace w JOIN ma_workspace_access a ON a.tenant_id = w.tenant_id AND a.workspace_id = w.workspace_id WHERE w.tenant_id = ? AND w.workspace_kind = 'ROOT' AND a.actor_id = ? AND a.role IN ('READER', 'OPERATOR', 'OWNER') UNION ALL SELECT CONCAT(c.tenant_id, '!'), CONCAT(c.workspace_id, '!') FROM ma_workspace c JOIN readable_workspace p ON CONCAT(c.tenant_id, '!') = p.tenant_identity AND CONCAT(c.parent_workspace_id, '!') = p.workspace_identity WHERE c.tenant_id = ? AND c.workspace_kind = 'CHILD_GIT') SELECT " + ManagedSchemaProjection.SCHEDULE.columns("s") + " FROM ma_schedule s WHERE s.tenant_id = ? AND EXISTS (SELECT 1 FROM readable_workspace r WHERE r.tenant_identity = CONCAT(s.tenant_id, '!') AND r.workspace_identity = CONCAT(s.workspace_id, '!'))"
                        + " AND EXISTS (SELECT 1 FROM ma_session ms WHERE ms.tenant_id = s.tenant_id"
                        + " AND ms.session_id = s.session_id AND (ms.owner_only = 0"
                        + " OR COALESCE(ms.owner_actor_key, ms.creator_actor_key) = ?))";
        List<ScheduleRow> rows = cursor == null
                ? jdbc.query(select + " ORDER BY s.gmt_create DESC,"
                        + " s.schedule_id DESC LIMIT ?", mapper, tenantId,
                        actorKey, tenantId, tenantId, actorKey, limit + 1)
                : jdbc.query(select + " AND (s.gmt_create < ?"
                        + " OR (s.gmt_create = ? AND s.schedule_id < ?))"
                        + " ORDER BY s.gmt_create DESC, s.schedule_id DESC"
                        + " LIMIT ?", mapper, tenantId, actorKey, tenantId, tenantId, actorKey,
                        cursor.createdAt(), cursor.createdAt(),
                        cursor.scheduleId(), limit + 1);
        boolean hasMore = rows.size() > limit;
        return new SchedulePage(hasMore ? rows.subList(0, limit) : rows,
                hasMore);
    }

    /**
     * Session-scoped page for the internal writer-binding routes: the binding
     * already authorized this exact Session, so the filter is the Session
     * itself, applied before the page limit (a controller-side post-filter
     * would cut the page first and derive a wrong cursor). No actor/workspace
     * reachability is re-derived here.
     */
    static SchedulePage listSession(JdbcTemplate jdbc, RowMapper<ScheduleRow> mapper,
            String tenantId, String sessionId, ScheduleCursor cursor, int limit) {
        // Retired definitions are history, not capacity: the internal list
        // feeds the model's inline tool_result, so the page is bounded by the
        // live capacity (32), never by the Session's lifetime creations.
        String select = "SELECT " + ManagedSchemaProjection.SCHEDULE.columns("s")
                + " FROM ma_schedule s WHERE s.tenant_id = ? AND s.session_id = ?"
                + " AND s.state = '" + AutomationLedgerStore.STATE_LIVE + "'";
        List<ScheduleRow> rows = cursor == null
                ? jdbc.query(select + " ORDER BY s.gmt_create DESC,"
                        + " s.schedule_id DESC LIMIT ?", mapper, tenantId,
                        sessionId, limit + 1)
                : jdbc.query(select + " AND (s.gmt_create < ?"
                        + " OR (s.gmt_create = ? AND s.schedule_id < ?))"
                        + " ORDER BY s.gmt_create DESC, s.schedule_id DESC"
                        + " LIMIT ?", mapper, tenantId, sessionId,
                        cursor.createdAt(), cursor.createdAt(),
                        cursor.scheduleId(), limit + 1);
        boolean hasMore = rows.size() > limit;
        return new SchedulePage(hasMore ? rows.subList(0, limit) : rows,
                hasMore);
    }

    static int countLive(JdbcTemplate jdbc, String tenantId, String sessionId,
            String liveState) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_schedule WHERE tenant_id = ?"
                        + " AND session_id = ? AND state = ?", Integer.class,
                tenantId, sessionId, liveState);
        return count == null ? 0 : count;
    }

    /** Live, enabled, unblocked definitions whose lease is free or expired. */
    static List<ScheduleRow> findArmed(JdbcTemplate jdbc, RowMapper<ScheduleRow> mapper,
            String liveState, long now, int limit) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.SCHEDULE.columns() + " FROM ma_schedule"
                        + " WHERE state = ? AND is_enabled = TRUE"
                        + " AND blocked_reason IS NULL"
                        + " AND (lease_until IS NULL OR lease_until < ?)"
                        + " ORDER BY gmt_modified, schedule_id LIMIT ?", mapper,
                liveState, now, limit);
    }
}
