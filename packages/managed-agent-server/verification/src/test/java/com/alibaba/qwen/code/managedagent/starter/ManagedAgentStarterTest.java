package com.alibaba.qwen.code.managedagent.starter;

import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.task.TaskSchedulingAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.web.bind.annotation.RestController;

import javax.sql.DataSource;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedAgentStarterTest {
    private ApplicationContextRunner runner() {
        return new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(
                        ManagedAgentAutoConfiguration.class,
                        JacksonAutoConfiguration.class,
                        TaskSchedulingAutoConfiguration.class));
    }

    @Test
    void dependencyAloneKeepsManagedResourcesDisabled() {
        runner().run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBeansOfType(ManagedAgentService.class)).isEmpty();
            assertThat(context.getBeansOfType(DataSource.class)).isEmpty();
            assertThat(context.containsBean("managedAgentExecutor")).isFalse();
            assertThat(context.containsBean("managedAgentDataSource")).isFalse();
        });
    }

    @Test
    void explicitEnableStartsJavaServicesWithoutServletSurfaces() {
        runner().withPropertyValues(
                "qwen.managed-agent.enabled=true",
                "qwen.managed-agent.datasource.url=" + url())
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(ManagedAgentService.class)).isNotNull();
                    assertThat(context.getBeansWithAnnotation(RestController.class)).isEmpty();
                    assertThat(context.getBeansOfType(TenantContextFilter.class)).isEmpty();
                });
    }

    @Test
    void validationOnlyDefersAnEmptyCatalogFailureWithoutCreatingTables() {
        String url = url();
        runner().withPropertyValues(
                "qwen.managed-agent.enabled=true",
                "qwen.managed-agent.schema.initialize-enabled=false",
                "qwen.managed-agent.datasource.url=" + url)
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThatThrownBy(() -> context.getBean(ManagedAgentService.class).getPublicSession(
                            new com.alibaba.qwen.code.managedagent.model.SessionPrincipal("tenant", "owner", null), "missing"))
                            .isInstanceOf(IllegalStateException.class)
                            .hasStackTraceContaining("Managed schema validation failed");
                });
        try (var connection = java.sql.DriverManager.getConnection(url, "", "");
                var tables = connection.getMetaData().getTables(connection.getCatalog(), null, "ma_%", new String[] {"TABLE"})) {
            assertThat(tables.next()).isFalse();
        } catch (java.sql.SQLException failure) {
            throw new AssertionError(failure);
        }
    }

    private static String url() {
        return "jdbc:h2:mem:starter-test-" + UUID.randomUUID() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    }
}
