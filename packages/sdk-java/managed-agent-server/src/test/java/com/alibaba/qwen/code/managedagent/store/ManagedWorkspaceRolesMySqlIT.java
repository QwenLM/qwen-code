package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/**
 * Real-engine counterpart of the V53 role-constraint shape: utf8mb4
 * comparisons ignore trailing spaces (PAD SPACE), so an IN-list CHECK
 * would accept and preserve 'READER ' — a value the enum parser rejects
 * at read time. The REGEXP constraint must store only byte-exact enum
 * names on the engines CI actually runs.
 */
class ManagedWorkspaceRolesMySqlIT {
    private JdbcTemplate admin;
    private JdbcTemplate jdbc;
    private DriverManagerDataSource data;

    @BeforeEach
    void setup() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "workspace_roles_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        data = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
        jdbc = new JdbcTemplate(data);
        Flyway.configure().dataSource(data).locations("classpath:db/migration").load().migrate();
    }

    @Test
    void roleCheckStoresOnlyByteExactEnumNames() {
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                + " workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 1, 'storage', 'Workspace',"
                + " 'config', 'policy', 'ACTIVE')");
        for (String canonical : List.of("READER", "OPERATOR", "OWNER")) {
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                    + " workspace_id, actor_id, role) VALUES ('tenant',"
                    + " 'workspace', ?, ?)",
                    ("actor-" + canonical).getBytes(StandardCharsets.UTF_8),
                    canonical);
        }
        assertThat(jdbc.queryForList("SELECT DISTINCT role FROM"
                + " managed_workspace_access", String.class))
                .containsExactlyInAnyOrder("READER", "OPERATOR", "OWNER");
        for (String rejected : List.of("NONE", "SPECTATOR", "reader",
                "READER ", "OPERATOR ", "OWNER ", "REA DER")) {
            assertThatThrownBy(() -> jdbc.update("INSERT INTO"
                    + " managed_workspace_access (tenant_id, workspace_id,"
                    + " actor_id, role) VALUES ('tenant', 'workspace', ?,"
                    + " ?)", "padded".getBytes(StandardCharsets.UTF_8),
                    rejected))
                    .as("role %s must be rejected", rejected)
                    .isInstanceOf(DataIntegrityViolationException.class);
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " managed_workspace_access WHERE actor_id = ?",
                Integer.class, "padded".getBytes(StandardCharsets.UTF_8)))
                .isZero();
    }
}
