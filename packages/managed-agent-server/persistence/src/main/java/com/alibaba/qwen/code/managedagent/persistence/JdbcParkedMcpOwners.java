package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.ParkedMcpOwners;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.persistence.RuntimeAdmissionFences;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Duration;
import java.util.List;

/** Reads parked owners from the Runtime Session rows and the Session journal head. */
public final class JdbcParkedMcpOwners implements ParkedMcpOwners {
    private final JdbcTemplate jdbc;

    public JdbcParkedMcpOwners(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // The prefixes are the Hosted Harness's durable MCP and extension owner ids.
    @Override
    public List<Owner> candidates(long afterId, int limit) {
        return jdbc.query("SELECT id, tenant_id, harness_session_id, binding_id, runtime_generation,"
                + " runtime_session_id, execution_storage_key FROM ma_runtime_session"
                + " WHERE id > ? AND session_state = 'READY' AND execution_storage_key IS NOT NULL"
                + " AND (runtime_session_id LIKE 'mcp-%' OR runtime_session_id LIKE 'extensions-components-%')"
                + " ORDER BY id LIMIT ?",
                (row, index) -> new Owner(row.getLong("id"), row.getString("tenant_id"),
                        row.getString("harness_session_id"), row.getString("binding_id"),
                        row.getLong("runtime_generation"), row.getString("runtime_session_id"),
                        row.getString("execution_storage_key")),
                afterId, limit);
    }

    @Override
    public boolean parked(Owner owner, Duration idle) {
        return !jdbc.queryForList("SELECT id FROM ma_session_head WHERE tenant_key = ? AND harness_key = ?"
                + " AND head_kind = 'MANAGED_SESSION' AND state = 'SEALED'"
                + " AND gmt_modified <= " + ManagedSchemaTime.SQL_NOW + " - ?",
                Long.class, RuntimeAdmissionFences.harnessDrainKey(owner.tenantId()),
                RuntimeAdmissionFences.harnessDrainKey(owner.harnessSessionId()), idle.toMillis()).isEmpty();
    }
}
