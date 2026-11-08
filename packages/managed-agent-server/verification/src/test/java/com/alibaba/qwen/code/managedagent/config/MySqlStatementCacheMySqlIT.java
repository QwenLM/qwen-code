package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.ManagedAgentServerApplication;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.mysql.cj.conf.PropertyKey;
import com.mysql.cj.conf.PropertySet;
import com.mysql.cj.jdbc.ClientPreparedStatement;
import com.mysql.cj.jdbc.JdbcConnection;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.mock.env.MockEnvironment;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The pools reach Connector/J with its parse cache on, so a statement prepared
 * again on one connection reuses the first parse, and a URL that turns the
 * cache off keeps it off.
 */
class MySqlStatementCacheMySqlIT {
    @Test
    void theServerPoolCachesParsesAfterBindingItsDruidSettings() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase();
                var context = server(database.url(),
                        "--spring.datasource.druid.connection-properties=prepStmtCacheSize=64;connectTimeout=5000");
                Connection connection = context.getBean("managedAgentDataSource", DruidDataSource.class).getConnection()) {
            PropertySet properties = properties(connection);
            assertThat(properties.getBooleanProperty(PropertyKey.cachePrepStmts).getValue()).isTrue();
            assertThat(properties.getIntegerProperty(PropertyKey.prepStmtCacheSize).getValue()).isEqualTo(64);
            assertThat(properties.getIntegerProperty(PropertyKey.prepStmtCacheSqlLimit).getValue()).isEqualTo(8192);
            assertThat(properties.getIntegerProperty(PropertyKey.connectTimeout).getValue()).isEqualTo(5000);
            assertThat(reusesParse(connection)).isTrue();
        }
    }

    @Test
    void theServerPoolKeepsACacheTheUrlTurnsOff() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase();
                var context = server(withParameter(database.url(), "cachePrepStmts=false"));
                Connection connection = context.getBean("managedAgentDataSource", DruidDataSource.class).getConnection()) {
            assertThat(properties(connection).getBooleanProperty(PropertyKey.cachePrepStmts).getValue()).isFalse();
            assertThat(reusesParse(connection)).isFalse();
        }
    }

    @Test
    void theEmbeddedPoolCachesParsesUnlessStatementsArePreparedOnTheServer() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            try (DruidDataSource source = embedded(database.url()); Connection connection = source.getConnection()) {
                PropertySet properties = properties(connection);
                assertThat(properties.getBooleanProperty(PropertyKey.cachePrepStmts).getValue()).isTrue();
                assertThat(properties.getIntegerProperty(PropertyKey.prepStmtCacheSize).getValue()).isEqualTo(512);
                assertThat(reusesParse(connection)).isTrue();
            }
            try (DruidDataSource source = embedded(withParameter(database.url(), "useServerPrepStmts=true"));
                    Connection connection = source.getConnection()) {
                assertThat(properties(connection).getBooleanProperty(PropertyKey.cachePrepStmts).getValue()).isFalse();
            }
        }
    }

    private static ConfigurableApplicationContext server(String url, String... more) {
        var args = new ArrayList<>(List.of(
                "--server.address=127.0.0.1", "--server.port=0",
                "--spring.datasource.url=" + url,
                "--spring.datasource.username=" + System.getProperty("mysql.user"),
                "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                "--spring.datasource.druid.max-active=2",
                "--spring.datasource.druid.max-wait=5000",
                "--qwen.managed-agent.harness.enabled=false",
                "--qwen.managed-agent.runtime-broker.enabled=false"));
        args.addAll(List.of(more));
        return new SpringApplicationBuilder(ManagedAgentServerApplication.class).run(args.toArray(String[]::new));
    }

    private static DruidDataSource embedded(String url) {
        return new ManagedAgentPersistenceConfiguration().managedAgentDataSource(new MockEnvironment()
                .withProperty("qwen.managed-agent.datasource.url", url)
                .withProperty("qwen.managed-agent.datasource.username", System.getProperty("mysql.user"))
                .withProperty("qwen.managed-agent.datasource.password", System.getProperty("mysql.password", ""))
                .withProperty("qwen.managed-agent.datasource.max-active", "1"));
    }

    private static String withParameter(String url, String parameter) {
        return url + (url.contains("?") ? "&" : "?") + parameter;
    }

    private static PropertySet properties(Connection connection) throws SQLException {
        return connection.unwrap(JdbcConnection.class).getPropertySet();
    }

    /** Whether preparing the same SQL twice on the connection parses it once. */
    private static boolean reusesParse(Connection connection) throws SQLException {
        String sql = "SELECT ? FROM DUAL";
        try (var first = connection.prepareStatement(sql); var second = connection.prepareStatement(sql)) {
            return first.unwrap(ClientPreparedStatement.class).getQueryInfo()
                    == second.unwrap(ClientPreparedStatement.class).getQueryInfo();
        }
    }
}
