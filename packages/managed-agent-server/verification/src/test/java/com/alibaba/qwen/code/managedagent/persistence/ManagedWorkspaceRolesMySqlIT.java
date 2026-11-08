package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

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
        // Drive a REAL writer end to end on the engine: the store's
        // completion path is what inserts the OWNER grant, so a writer that
        // stops validating (or stores a drifted literal) fails here instead
        // of being blessed by a helper-only call.
        var store = new SshWorkspaceStore(jdbc,
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(data));
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "owner");
        assertThat(intent).isNotNull();
        java.util.Map<String, Object> identity = java.util.Map.of(
                "root", "/work/project", "hostId", "host", "device", "1",
                "inode", "2", "birthTime", "3");
        var marker = new java.util.LinkedHashMap<String, Object>(identity);
        marker.put("version", 2);
        marker.put("tenantId", intent.tenantId());
        marker.put("storageId", intent.storageId());
        marker.put("registrationId", intent.registrationId());
        store.reserve(intent, "owner", java.util.Map.of(
                "nodeId", intent.nodeId(), "identity", identity,
                "marker", marker, "qwenVersion", "0.25.1"));
        store.complete(intent, "owner");
        assertThat(jdbc.queryForList("SELECT DISTINCT role FROM"
                + " ma_workspace_access", String.class))
                .containsExactly("OWNER");
        // The engine itself no longer refuses a drifted role (the baseline
        // carries no CHECK), so the writer's pre-insert validation is the
        // only guard; prove that by letting a raw padded write land.
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES ('tenant',"
                + " 'workspace-raw', ?, 'OWNER ')",
                "raw".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " ma_workspace_access WHERE role = 'OWNER'", Integer.class))
                .as("MySQL PAD SPACE matches the padded role: only the writer's guard can refuse it")
                .isEqualTo(2);
        jdbc.update("DELETE FROM ma_workspace_access WHERE workspace_id = 'workspace-raw'");
        // Each rejected variant travels the SAME writer path: the store
        // validates the literal it is about to insert, so a writer that
        // stops validating lets a padded role reach MySQL's PAD SPACE
        // comparison and this case reds.
        int index = 0;
        for (String rejected : List.of("NONE", "SPECTATOR", "reader",
                "READER ", "OPERATOR ", "OWNER ", "REA DER")) {
            index++;
            String variant = rejected;
            var drifted = new SshWorkspaceStore(jdbc,
                    new org.springframework.jdbc.datasource.DataSourceTransactionManager(data)) {
                @Override
                protected String ownerRole() {
                    return variant;
                }
            };
            var attempt = drifted.begin("tenant", "actor", "key-" + index,
                    "mac", "/work/variant-" + index, "Variant");
            var claimed = drifted.claim("tenant", "actor",
                    attempt.operationId(), "owner");
            assertThat(claimed).isNotNull();
            java.util.Map<String, Object> variantIdentity = java.util.Map.of(
                    "root", "/work/variant-" + index, "hostId", "host",
                    "device", "1", "inode", String.valueOf(100 + index),
                    "birthTime", "3");
            var variantMarker = new java.util.LinkedHashMap<String, Object>(variantIdentity);
            variantMarker.put("version", 2);
            variantMarker.put("tenantId", claimed.tenantId());
            variantMarker.put("storageId", claimed.storageId());
            variantMarker.put("registrationId", claimed.registrationId());
            drifted.reserve(claimed, "owner", java.util.Map.of(
                    "nodeId", claimed.nodeId(), "identity", variantIdentity,
                    "marker", variantMarker, "qwenVersion", "0.25.1"));
            assertThatThrownBy(() -> drifted.complete(claimed, "owner"))
                    .as("role %s must be rejected by the writer before persistence", rejected)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("ck_ma_access_role");
        }
        // The rejected variants rolled back with their transactions: only
        // the canonical OWNER grant persisted.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access",
                Integer.class)).isEqualTo(1);
    }
}
