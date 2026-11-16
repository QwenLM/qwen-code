package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ChildResultRelayStore.BootstrapAdmission;
import com.alibaba.qwen.code.managedagent.repository.ChildResultRelayStore.RelayRow;
import com.alibaba.qwen.code.managedagent.repository.ChildResultRelayStore.TurnLine;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;

final class ChildTurnQueries {
    private static final String COLUMNS = "turn_id, status, completed_at, error_code,"
            + " is_submission_attempted, harness_event_epoch";

    private ChildTurnQueries() { }

    static BootstrapAdmission bootstrap(JdbcTemplate jdbc, RelayRow relay, String child) {
        var profiles = jdbc.query("SELECT tool_profile FROM ma_session WHERE tenant_id=? AND session_id=?",
                (row, index) -> row.getString(1), relay.tenantId(), child);
        if (profiles.size() != 1 || !WorkspaceToolProfiles.EXTERNAL_CONTENT.equals(profiles.getFirst())) {
            return null;
        }
        var receipt = ManagedReceipts.creation(jdbc, relay.tenantId(),
                ManagedWorkspaceRegistry.actorKey(relay.tenantId(), ChildSessionAdmissions.childActorOf(relay.parentSessionId())),
                relay.creationKey());
        if (receipt == null || !child.equals(receipt.sessionId()) || receipt.turnId() == null
                || !"COMPLETED".equals(receipt.state())) {
            throw unavailable();
        }
        var rows = jdbc.query("SELECT t." + COLUMNS.replace(", ", ", t.") + ", t.prompt_id FROM ma_turn t"
                + " JOIN ma_session c ON c.tenant_id=t.tenant_id AND c.session_id=t.session_id"
                + " JOIN ma_session p ON p.tenant_id=c.tenant_id AND p.session_id=c.parent_session_id"
                + " WHERE t.tenant_id=? AND t.session_id=? AND t.turn_id=?"
                + " AND c.parent_session_id=? AND c.parent_child_run_id=? AND c.child_depth=1"
                + " AND c.root_session_id=p.session_id AND p.parent_session_id IS NULL"
                + " AND p.tool_profile=c.tool_profile AND c.public_child_agents_version=1"
                + " AND p.public_child_agents_version=1 AND c.workspace_id=p.workspace_id"
                + " AND c.workspace_generation=p.workspace_generation"
                + " AND c.workspace_storage_id=p.workspace_storage_id AND c.cwd_relative=p.cwd_relative"
                + " AND c.context_config_ref=p.context_config_ref AND c.context_revision=p.context_revision",
                (row, index) -> new BootstrapAdmission(child, row.getString("prompt_id"), line(row)),
                relay.tenantId(), child, receipt.turnId(), relay.parentSessionId(), relay.childRunId());
        if (rows.size() != 1 || rows.getFirst().promptId() == null) {
            throw unavailable();
        }
        return rows.getFirst();
    }

    static TurnLine ordered(JdbcTemplate jdbc, String tenant, String session, boolean newest) {
        String order = newest ? "DESC" : "ASC";
        List<TurnLine> rows = jdbc.query("SELECT " + COLUMNS + " FROM ma_turn"
                + " WHERE tenant_id=? AND session_id=? ORDER BY gmt_create " + order
                + ", turn_id " + order + " LIMIT 1", (row, index) -> line(row), tenant, session);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private static TurnLine line(ResultSet row) throws SQLException {
        return new TurnLine(row.getString("turn_id"), row.getString("status"),
                row.getObject("completed_at", Long.class), row.getString("error_code"),
                row.getBoolean("is_submission_attempted"), row.getString("harness_event_epoch"));
    }

    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(409, "child_bootstrap_unavailable",
                "The child's original admission identity is unavailable.");
    }
}
