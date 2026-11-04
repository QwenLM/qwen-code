package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.HashSet;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ManagedDataSourceSqlModeMySqlIT {
    @Test
    void initializesEveryPhysicalConnectionWithoutChangingGlobalMode() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            String url = database.url() + (database.url().contains("?") ? "&" : "?")
                    + "jdbcCompliantTruncation=false&sessionVariables=sql_mode='NO_ENGINE_SUBSTITUTION'";
            String user = System.getProperty("mysql.user");
            String password = System.getProperty("mysql.password", "");
            String global;
            try (var raw = DriverManager.getConnection(url, user, password)) {
                global = mode(raw, "GLOBAL");
                assertEquals("NO_ENGINE_SUBSTITUTION", mode(raw, "SESSION"));
                assertThrows(SQLException.class, () -> ManagedSchema.requireApplicationCatalog(raw));
            }
            String expectedGlobal = System.getProperty("mysql.expected.global.sqlmode");
            if (expectedGlobal != null) {
                assertEquals(expectedGlobal, global);
            }
            var environment = new MockEnvironment()
                    .withProperty("qwen.managed-agent.datasource.url", url)
                    .withProperty("qwen.managed-agent.datasource.username", user)
                    .withProperty("qwen.managed-agent.datasource.password", password)
                    .withProperty("qwen.managed-agent.datasource.max-active", "2");
            try (DruidDataSource source = new ManagedAgentPersistenceConfiguration().managedAgentDataSource(environment)) {
                source.setTestOnBorrow(true);
                source.setMaxWait(5_000);
                ManagedSchema.initialize(source);
                ManagedSchema.validate(source);
                Set<Long> retired = strictConnectionIds(source, global);
                try (var admin = database.source().getConnection(); var statement = admin.createStatement()) {
                    for (long id : retired) {
                        statement.execute("KILL CONNECTION " + id);
                    }
                }
                Set<Long> replacements = strictConnectionIds(source, global);
                assertTrue(retired.stream().noneMatch(replacements::contains));
                try (var connection = source.getConnection(); var statement = connection.createStatement()) {
                    statement.execute("INSERT INTO ma_read_lease"
                            + " (lease_id, tenant_key, session_key, retirement_generation, expires_at)"
                            + " VALUES ('session-mode-probe', REPEAT('a',64), REPEAT('b',64), 7, 1)");
                    var error = assertThrows(SQLException.class, () -> statement.execute(
                            "UPDATE ma_read_lease SET retirement_generation=-1 WHERE lease_id='session-mode-probe'"));
                    assertEquals(1264, error.getErrorCode());
                    try (var rows = statement.executeQuery("SELECT retirement_generation FROM ma_read_lease")) {
                        assertTrue(rows.next());
                        assertEquals(7, rows.getLong(1));
                    }
                    assertEquals(global, mode(connection, "GLOBAL"));
                    statement.execute("SET SESSION sql_mode=''");
                    assertThrows(SQLException.class, () -> ManagedSchema.requireApplicationCatalog(connection));
                }
            }
        }
    }

    private static Set<Long> strictConnectionIds(DruidDataSource source, String global) throws SQLException {
        var ids = new HashSet<Long>();
        try (var first = source.getConnection(); var second = source.getConnection()) {
            for (var connection : new Connection[] {first, second}) {
                ManagedSchema.requireApplicationCatalog(connection);
                String session = mode(connection, "SESSION");
                assertTrue(Set.of(session.split(",")).contains("STRICT_TRANS_TABLES"));
                assertTrue(Set.of(session.split(",")).contains("NO_ENGINE_SUBSTITUTION"));
                assertEquals(global, mode(connection, "GLOBAL"));
                try (var statement = connection.createStatement(); var rows = statement.executeQuery("SELECT CONNECTION_ID()")) {
                    assertTrue(rows.next());
                    assertTrue(ids.add(rows.getLong(1)));
                }
            }
        }
        assertEquals(2, ids.size());
        assertFalse(ids.contains(0L));
        return ids;
    }

    private static String mode(Connection connection, String scope) throws SQLException {
        try (var statement = connection.createStatement(); var rows = statement.executeQuery("SELECT @@" + scope + ".sql_mode")) {
            assertTrue(rows.next());
            return rows.getString(1);
        }
    }
}
