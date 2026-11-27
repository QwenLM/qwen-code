package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.ParkedMcpOwners;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import java.time.Duration;
import java.util.List;
import java.util.Optional;

/** Reads parked owners from the Runtime Session rows and the Session journal head. */
public final class JdbcParkedMcpOwners implements ParkedMcpOwners {
    // The prefixes are the Hosted Harness's durable MCP and extension owner ids.
    private static final String OWNERS = "SELECT id, tenant_id, harness_session_id, binding_id, runtime_generation,"
            + " runtime_session_id, execution_storage_id FROM ma_runtime_session"
            + " WHERE session_state = 'READY' AND execution_storage_id IS NOT NULL"
            + " AND (runtime_session_id LIKE 'mcp-%' OR runtime_session_id LIKE 'extensions-components-%')";
    private static final RowMapper<Owner> OWNER = (row, index) -> new Owner(row.getLong("id"),
            row.getString("tenant_id"), row.getString("harness_session_id"), row.getString("binding_id"),
            row.getLong("runtime_generation"), row.getString("runtime_session_id"),
            row.getString("execution_storage_id"));

    private final JdbcTemplate jdbc;

    public JdbcParkedMcpOwners(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public List<Owner> candidates(long afterId, int limit) {
        return jdbc.query(OWNERS + " AND id > ? ORDER BY id LIMIT ?", OWNER, afterId, limit);
    }

    @Override
    public List<Owner> onStorage(String storageKey, int limit) {
        return jdbc.query(OWNERS + " AND execution_storage_id = ? ORDER BY id LIMIT ?", OWNER,
                ManagedSchemaKeys.identity(storageKey), limit);
    }

    @Override
    public Optional<Duration> sealedFor(Owner owner) {
        // A seal that parked a Turn keeps the owner whose catalog that Turn's
        // continuation pins; writer acquisition clears the certificate.
        return jdbc.queryForList("SELECT " + ManagedSchemaTime.SQL_NOW + " - gmt_modified FROM ma_session_head"
                + " WHERE tenant_id = ? AND harness_session_id = ? AND head_kind = 'MANAGED_SESSION' AND state = 'SEALED'"
                + " AND wake_seal_parked_prompt_id IS NULL",
                Long.class, owner.tenantId(), owner.harnessSessionId())
                .stream().findFirst().map(Duration::ofMillis);
    }
}
