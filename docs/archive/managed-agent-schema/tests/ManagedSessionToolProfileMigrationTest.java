package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

class ManagedSessionToolProfileMigrationTest {
    @Test
    void pinsLegacyWorkspaceProfilesAndSupportsOldBinaryInserts() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:tool-profile-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(source).target("34").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(source);
        insertLegacySession(jdbc, "old-bound", true);
        insertLegacySession(jdbc, "old-unbound", false);

        Flyway.configure().dataSource(source).load().migrate();

        assertThat(profile(jdbc, "old-bound")).isEqualTo("hosted-workspace-files/1");
        assertThat(profile(jdbc, "old-unbound")).isNull();
        assertThat(jdbc.queryForObject("SELECT approval_mode FROM managed_agent_session"
                + " WHERE session_id = 'old-bound'", String.class)).isEqualTo("yolo");
        insertLegacySession(jdbc, "late-bound", true);
        insertLegacySession(jdbc, "late-unbound", false);
        assertThat(profile(jdbc, "late-bound")).isEqualTo("hosted-workspace-files/1");
        // Older writers omit the column; the connector ignores it on unbound Sessions.
        assertThat(profile(jdbc, "late-unbound")).isEqualTo("hosted-workspace-files/1");
    }

    private static String profile(JdbcTemplate jdbc, String id) {
        return jdbc.queryForObject("SELECT tool_profile FROM managed_agent_session"
                + " WHERE session_id = ?", String.class, id);
    }

    private static void insertLegacySession(JdbcTemplate jdbc, String id, boolean bound) {
        jdbc.update("INSERT INTO managed_agent_session"
                + " (tenant_id, session_id, agent_id, status, created_at, updated_at)"
                + " VALUES ('tenant', ?, 'qwen-code', 'ACTIVE', 1, 1)", id);
        if (bound) {
            jdbc.update("UPDATE managed_agent_session SET workspace_id = 'workspace',"
                    + " workspace_generation = 1, workspace_storage_id = 'storage',"
                    + " cwd_relative = '.', context_config_ref = 'context', context_revision = 1,"
                    + " workspace_config_ref = 'config', workspace_policy_ref = 'policy'"
                    + " WHERE session_id = ?", id);
        }
    }
}
