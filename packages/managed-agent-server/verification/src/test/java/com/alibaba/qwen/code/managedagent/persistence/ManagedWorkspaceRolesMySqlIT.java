package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 在真实引擎上保留规范角色值，并在 Java 写入校验拒绝大小写及尾随空格变体。 */
class ManagedWorkspaceRolesMySqlIT {
    private JdbcTemplate admin;
    private JdbcTemplate jdbc;
    private DriverManagerDataSource data;
    private String schema;

    @BeforeEach
    void setup() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new ManagedSchemaJdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "workspace_roles_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
        jdbc = new ManagedSchemaJdbcTemplate(data);
        ManagedSchema.initialize(data);
    }

    @AfterEach
    void cleanup() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    @Test
    void roleCheckStoresOnlyByteExactEnumNames() {
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                + " workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 1, 'storage', 'Workspace',"
                + " 'config', 'policy', 'ACTIVE')");
        for (String canonical : List.of("READER", "OPERATOR", "OWNER")) {
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                    + " workspace_id, actor_id, role) VALUES ('tenant',"
                    + " 'workspace', ?, ?)",
                    ("actor-" + canonical).getBytes(StandardCharsets.UTF_8),
                    canonical);
        }
        assertThat(jdbc.queryForList("SELECT DISTINCT role FROM"
                + " ma_workspace_access", String.class))
                .containsExactlyInAnyOrder("READER", "OPERATOR", "OWNER");
        for (String rejected : List.of("NONE", "SPECTATOR", "reader",
                "READER ", "OPERATOR ", "OWNER ", "REA DER")) {
            assertThatThrownBy(() -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.validate(
                    "ma_workspace_access", com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.row(
                            "role", rejected)))
                    .as("role %s must be rejected before persistence", rejected)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("ck_ma_access_role");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_workspace_access WHERE actor_id = ?",
                Integer.class, "padded".getBytes(StandardCharsets.UTF_8)))
                .isZero();
    }
}
