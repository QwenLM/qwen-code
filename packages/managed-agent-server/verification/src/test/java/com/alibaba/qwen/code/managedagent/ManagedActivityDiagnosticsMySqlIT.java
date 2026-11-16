package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedActivityDiagnosticsMySqlIT extends ManagedActivityDiagnosticsTest {
    private IsolatedManagedSchemaMySqlTestDatabase database;

    @Override
    protected DataSource dataSource() {
        database = new IsolatedManagedSchemaMySqlTestDatabase();
        return database.source();
    }

    @AfterEach
    void cleanup() {
        if (database != null) {
            database.close();
        }
    }

    @Test
    void activityIndexSupportsSessionDomainKeysetReads() {
        var jdbc = new org.springframework.jdbc.core.JdbcTemplate(database.source());
        var plan = jdbc.queryForList("EXPLAIN SELECT record_resource_id, gmt_create, record_key FROM ma_session_record"
                + " WHERE record_kind = 'DOMAIN' AND session_scope_key = ? AND domain = ? AND delivery_state IS NULL"
                + " ORDER BY gmt_create DESC, record_key DESC LIMIT 512", "scope",
                "hosted_tool_diagnostic");
        assertThat(plan).hasSize(1);
        assertThat(String.valueOf(plan.getFirst().get("possible_keys"))).contains("idx_ma_record_session_delivery");
    }
}
