package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class HostedMySqlIsolationIT {
    @Test
    @Timeout(120)
    void clearsRecoveryTargetsAndRetainsSchemaHistoryBetweenClasses() throws Exception {
        var source = new DriverManagerDataSource(System.getProperty("mysql.url"),
                System.getProperty("mysql.user"), System.getProperty("mysql.password", ""));
        var jdbc = new JdbcTemplate(source);
        try (var spring = start()) {
            var store = spring.getBean(ManagedAgentStore.class);
            String session = store.insertSessionCommand("isolation", "CREATE_SESSION",
                    "close-session", "digest", "qwen-code", null, null, List.of(), null).sessionId();
            store.beginOperation("isolation", session, OperationKind.CLOSE, "", "close", "digest");
            store.insertSessionCommand("isolation", "CREATE_SESSION", "turn-session", "digest",
                    "qwen-code", null, null, List.of(Map.of("type", "input_text", "text", "hello")), "digest");
            assertThat(store.findDeliverableOperations(System.currentTimeMillis(), 100)).hasSize(1);
            assertThat(store.findDispatchable(System.currentTimeMillis(), 100)).hasSize(1);
        }
        var history = jdbc.queryForList("SELECT * FROM flyway_schema_history ORDER BY installed_rank");
        assertThat(history).isNotEmpty();

        var top = mock(ExtensionContext.class);
        when(top.getConfigurationParameter(HostedMySqlIsolationExtension.ENABLED))
                .thenReturn(Optional.of("true"));
        var nested = mock(ExtensionContext.class);
        when(nested.getConfigurationParameter(HostedMySqlIsolationExtension.ENABLED))
                .thenReturn(Optional.of("true"));
        when(nested.getParent()).thenReturn(Optional.of(top));
        when(top.getTestClass()).thenReturn(Optional.of(getClass()));
        var isolation = new HostedMySqlIsolationExtension();
        isolation.beforeAll(nested);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn", Integer.class)).isEqualTo(1);

        jdbc.execute("CREATE TABLE hosted_isolation_sentinel (id INT PRIMARY KEY)");
        try {
            jdbc.update("INSERT INTO hosted_isolation_sentinel (id) VALUES (1)");
            isolation.beforeAll(top);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM hosted_isolation_sentinel", Integer.class))
                    .isEqualTo(1);
            List<String> tables = jdbc.queryForList("SELECT TABLE_NAME FROM information_schema.TABLES"
                    + " WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'", String.class);
            assertThat(tables).contains("ma_operation", "ma_turn", "ma_session");
            for (String table : tables) {
                if (table.startsWith("ma_")) {
                    assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM `" + table + "`", Integer.class))
                            .as(table).isZero();
                }
            }
            assertThat(jdbc.queryForList("SELECT * FROM flyway_schema_history ORDER BY installed_rank"))
                    .isEqualTo(history);
        } finally {
            jdbc.execute("DROP TABLE hosted_isolation_sentinel");
        }
        ManagedSchema.validate(source);
        try (var spring = start()) {
            var store = spring.getBean(ManagedAgentStore.class);
            assertThat(store.findDeliverableOperations(System.currentTimeMillis(), 100)).isEmpty();
            assertThat(store.findDispatchable(System.currentTimeMillis(), 100)).isEmpty();
            assertThat(store.findRuntimeRecoveryParked(System.currentTimeMillis(), 100)).isEmpty();
            assertThat(store.insertSessionCommand("next-class", "CREATE_SESSION", "create", "digest",
                    "qwen-code", null, null, List.of(), null).sessionId()).isNotBlank();
        }
    }

    private ConfigurableApplicationContext start() {
        return new SpringApplicationBuilder(ManagedAgentServerApplication.class)
                .run("--server.address=127.0.0.1", "--server.port=0",
                        "--spring.datasource.url=" + System.getProperty("mysql.url"),
                        "--spring.datasource.username=" + System.getProperty("mysql.user"),
                        "--spring.datasource.password=" + System.getProperty("mysql.password", ""),
                        "--spring.datasource.driver-class-name=com.mysql.cj.jdbc.Driver",
                        "--qwen.managed-agent.harness.enabled=false",
                        "--qwen.managed-agent.runtime-broker.enabled=false");
    }
}
