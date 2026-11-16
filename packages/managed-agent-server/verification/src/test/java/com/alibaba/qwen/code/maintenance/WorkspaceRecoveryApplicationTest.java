package com.alibaba.qwen.code.maintenance;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.io.IOException;
import java.net.URL;
import java.util.Collections;
import java.util.Enumeration;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceRecoveryApplicationTest {
    @Test
    void sqlMaintenanceDoesNotDiscoverOrRequireOnlineFactories() {
        var discoveries = new AtomicInteger();
        ClassLoader previous = Thread.currentThread().getContextClassLoader();
        var withoutFactories = new ClassLoader(previous) {
            @Override
            public Enumeration<URL> getResources(String name) throws IOException {
                if (name.equals("META-INF/services/" + RuntimeProviderFactory.class.getName())) {
                    discoveries.incrementAndGet();
                    return Collections.emptyEnumeration();
                }
                return super.getResources(name);
            }
        };
        String prefix = "qwen.managed-agent.runtime-broker.";
        Thread.currentThread().setContextClassLoader(withoutFactories);
        try {
            new ApplicationContextRunner().withClassLoader(withoutFactories)
                    .withUserConfiguration(WorkspaceRecoveryApplication.class)
                    .withPropertyValues(
                            "spring.datasource.url=jdbc:h2:mem:maintenance-" + UUID.randomUUID()
                                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
                            "spring.datasource.username=sa",
                            "qwen.managed-agent.harness.enabled=true",
                            "qwen.managed-agent.harness.workspace-files-enabled=true",
                            "qwen.managed-agent.session-store.enabled=true",
                            prefix + "enabled=true", prefix + "provisioner=local-process",
                            prefix + "verified-workspace-recovery-enabled=true")
                    .run(context -> {
                        assertThat(context).hasNotFailed();
                        assertThat(discoveries).hasValue(0);
                        var properties = context.getBean(ManagedAgentProperties.class);
                        assertThatThrownBy(properties::validateRuntimeProvider)
                                .hasMessageContaining("not installed: local-process");
                    });
        } finally {
            Thread.currentThread().setContextClassLoader(previous);
        }
    }

    @Test
    void bindsAndClosesMaintenanceDataSource() {
        var source = new java.util.concurrent.atomic.AtomicReference<DruidDataSource>();
        new ApplicationContextRunner().withUserConfiguration(WorkspaceRecoveryApplication.class)
                .withPropertyValues("spring.datasource.url=jdbc:h2:mem:maintenance",
                        "spring.datasource.username=sa", "spring.datasource.druid.max-active=7")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    source.set(context.getBean(DruidDataSource.class));
                    assertThat(source.get().getMaxActive()).isEqualTo(7);
                    try (var connection = source.get().getConnection();
                            var statement = connection.createStatement()) {
                        statement.execute("CREATE TABLE maintenance_probe (id INTEGER)");
                        statement.executeUpdate("INSERT INTO maintenance_probe VALUES (1)");
                        try (var rows = statement.executeQuery("SELECT id FROM maintenance_probe")) {
                            assertThat(rows.next()).isTrue();
                            assertThat(rows.getInt(1)).isEqualTo(1);
                        }
                    } catch (java.sql.SQLException error) {
                        throw new AssertionError(error);
                    }
                    assertThat(context.containsBean("managedAgentService")).isFalse();
                });
        assertThat(source.get().isClosed()).isTrue();
    }
}
