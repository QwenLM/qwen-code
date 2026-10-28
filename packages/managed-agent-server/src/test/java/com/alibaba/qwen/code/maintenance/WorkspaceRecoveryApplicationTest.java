package com.alibaba.qwen.code.maintenance;

import com.alibaba.druid.pool.DruidDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import static org.assertj.core.api.Assertions.assertThat;

class WorkspaceRecoveryApplicationTest {
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
