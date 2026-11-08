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
        // The domain rule the writers route through still refuses every
        // case/space variant before persistence.
        for (String rejected : List.of("NONE", "SPECTATOR", "reader",
                "READER ", "OPERATOR ", "OWNER ", "REA DER")) {
            assertThatThrownBy(() -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.validate(
                    "ma_workspace_access",
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaIntegrity.row("role", rejected)))
                    .as("role %s must be rejected before persistence", rejected)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("ck_ma_access_role");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace_access",
                Integer.class)).isEqualTo(1);
    }
}
