package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;

import java.sql.SQLException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class EmbeddedManagedAgentStartupMySqlIT {
    @Test
    void starterUsesRealManagedDatabaseAndRetainsPublicServiceBehavior() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var context = start(database);
            var bootstrap = context.getBean(EmbeddedManagedAgentBootstrap.class);
            try (context) {
                var consumer = context.getBean(Consumer.class);
                assertMissingSession(consumer.service());
                assertThat(bootstrap.isAvailable()).isTrue();
                assertThat(context.getBean(BusinessBean.class).value()).isEqualTo("host");
                assertThat(context.containsBean("managedJdbcTemplate")).isFalse();
            }
            assertThat(bootstrap.isAvailable()).isFalse();
        }
    }

    @Test
    void partialRealCatalogFailsManagedCallsWithoutStoppingHostOrWritingSchema() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase();
                var connection = database.source().getConnection();
                var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE ma_session_principal (id BIGINT)");
            try (var context = start(database)) {
                var bootstrap = context.getBean(EmbeddedManagedAgentBootstrap.class);
                assertThat(context.getBean(BusinessBean.class).value()).isEqualTo("host");
                assertThatThrownBy(() -> context.getBean(ManagedAgentService.class)
                        .getPublicSession(new SessionPrincipal("tenant", "owner", null), "missing"))
                        .isInstanceOf(IllegalStateException.class)
                        .hasRootCauseInstanceOf(SQLException.class)
                        .hasStackTraceContaining("must contain exactly");
                assertThat(bootstrap.isAvailable()).isFalse();
                try (var tables = connection.getMetaData().getTables(
                        connection.getCatalog(), null, "%", new String[] {"TABLE"})) {
                    int count = 0;
                    while (tables.next()) {
                        count++;
                    }
                    assertThat(count).isOne();
                }
            }
        }
    }

    @Test
    void missingRealColumnFailsManagedCallsButNotUnrelatedHostBusiness() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase();
                var connection = database.source().getConnection();
                var statement = connection.createStatement()) {
            ManagedSchema.initialize(database.source());
            statement.execute("ALTER TABLE ma_agent_definition DROP COLUMN definition_json");
            try (var context = start(database)) {
                var bootstrap = context.getBean(EmbeddedManagedAgentBootstrap.class);
                assertThat(context.getBean(BusinessBean.class).value()).isEqualTo("host");
                assertUnavailable(context)
                        .hasRootCauseInstanceOf(SQLException.class)
                        .hasStackTraceContaining("Managed schema column is missing: ma_agent_definition.definition_json");
                assertThat(bootstrap.isAvailable()).isFalse();
                try (var columns = connection.getMetaData().getColumns(
                        connection.getCatalog(), null, "ma_agent_definition", "definition_json")) {
                    assertThat(columns.next()).isFalse();
                }
            }
        }
    }

    private static ConfigurableApplicationContext start(IsolatedManagedSchemaMySqlTestDatabase database) {
        var application = new SpringApplication(Host.class);
        application.setWebApplicationType(WebApplicationType.NONE);
        var context = application.run(
                "--qwen.managed-agent.enabled=true",
                "--qwen.managed-agent.datasource.url=" + database.url(),
                "--qwen.managed-agent.datasource.username=" + System.getProperty("mysql.user"),
                "--qwen.managed-agent.datasource.password=" + System.getProperty("mysql.password", ""));
        return context;
    }

    private static org.assertj.core.api.AbstractThrowableAssert<?, ?> assertUnavailable(
            ConfigurableApplicationContext context) {
        return assertThatThrownBy(() -> context.getBean(ManagedAgentService.class)
                .getPublicSession(new SessionPrincipal("tenant", "owner", null), "missing"))
                .isInstanceOf(IllegalStateException.class);
    }

    private static void assertMissingSession(ManagedAgentService service) {
        assertThatThrownBy(() -> service.getPublicSession(new SessionPrincipal("tenant", "owner", null), "missing"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(404);
                    assertThat(error.getCode()).isEqualTo("session_not_found");
                });
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration
    static class Host {
        @Bean
        Consumer consumer(ManagedAgentService service) {
            return new Consumer(service);
        }

        @Bean
        BusinessBean businessBean() {
            return new BusinessBean();
        }
    }

    record Consumer(ManagedAgentService service) {
    }

    static class BusinessBean {
        String value() {
            return "host";
        }
    }
}
