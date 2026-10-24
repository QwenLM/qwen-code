package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedSessionToolProfileMigrationTest {
    @Test
    void freshSessionsPinTheDefaultAndKeepExplicitProfiles() {
        var source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:tool-profile-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        var jdbc = new JdbcTemplate(source);
        for (String id : new String[] {"bound", "unbound", "explicit"}) {
            jdbc.update(
                    "INSERT INTO ma_session (tenant_id,session_id,agent_id,gmt_create,gmt_modified)"
                        + " VALUES (?,?,?,?,?)",
                    "tenant",
                    id,
                    "qwen-code",
                    1,
                    1);
        }
        jdbc.update(
                "UPDATE ma_session SET workspace_id=?, workspace_generation=1, workspace_storage_id=?,"
                        + " cwd_relative='.', context_config_ref=?, context_revision=1,"
                        + " workspace_config_ref=?, workspace_policy_ref=? WHERE session_id=?",
                "workspace", "storage", "context-profile", "workspace-config", "workspace-policy", "bound");
        jdbc.update(
                "UPDATE ma_session SET tool_profile=? WHERE session_id=?",
                "hosted-workspace-shell/1",
                "explicit");
        assertThat(profile(jdbc, "bound")).isEqualTo("hosted-workspace-files/1");
        assertThat(profile(jdbc, "unbound")).isEqualTo("hosted-workspace-files/1");
        assertThat(profile(jdbc, "explicit")).isEqualTo("hosted-workspace-shell/1");
        assertThat(
                        jdbc.queryForObject(
                                "SELECT approval_mode FROM ma_session WHERE session_id=?",
                                String.class,
                                "bound"))
                .isEqualTo("yolo");
        ManagedSchema.initialize(source);
        assertThat(profile(jdbc, "explicit")).isEqualTo("hosted-workspace-shell/1");
    }

    private static String profile(JdbcTemplate jdbc, String id) {
        return jdbc.queryForObject(
                "SELECT tool_profile FROM ma_session WHERE session_id=?", String.class, id);
    }
}
