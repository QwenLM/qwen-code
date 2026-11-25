package example;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.config.EmbeddedManagedAgentBootstrap;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionPreparation;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedAgentBootstrapPreparation;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.Test;
import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.RestController;

import javax.sql.DataSource;

import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class StarterHostTest {
    @Test
    void startsWithoutExplicitImport() {
        try (var context = start("--qwen.managed-agent.datasource.url=" + url())) {
            assertNormalSessionRead(context);
            assertThat(AopUtils.isAopProxy(context.getBean(TransactionalHostBean.class))).isTrue();
            assertThat(context.getBean(EmbeddedManagedAgentBootstrap.class).isAvailable()).isTrue();
            assertThat(context.containsBean("managedAgentExecutor")).isFalse();
            assertThat(context.containsBean("managedJdbcTemplate")).isFalse();
            assertThat(context.getBeansWithAnnotation(RestController.class)).isEmpty();
            assertThat(context.getBeansOfType(TenantContextFilter.class)).isEmpty();
            assertThat(context.getBean(ManagedAgentDefinitionPreparation.class)).isNotNull();
            assertThat(context.getBean(ManagedAgentBootstrapPreparation.class)).isNotNull();
        }
    }

    @Test
    void failuresAreDeferredInsteadOfStoppingTheHost() {
        try (var context = start()) {
            var service = context.getBean(ManagedAgentService.class);
            assertUnavailable(service).hasStackTraceContaining("qwen.managed-agent.datasource.url");
            assertThatThrownBy(() -> context.getBean(ManagedAgentDefinitionPreparation.class).prepare(null))
                    .isInstanceOf(IllegalStateException.class)
                    .hasStackTraceContaining("qwen.managed-agent.datasource.url");
            assertThatThrownBy(() -> context.getBean(ManagedAgentBootstrapPreparation.class).prepare(null, List.of()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasStackTraceContaining("qwen.managed-agent.datasource.url");
            assertThat(context.getBean(EmbeddedManagedAgentBootstrap.class).isAvailable()).isFalse();
            assertThat(context.getBean(TransactionalHostBean.class).value()).isEqualTo("host");
        }
    }

    @Test
    void partialSchemaReturnsFailureProxiesWithoutStoppingHostBusiness() throws Exception {
        String url = url();
        try (var connection = DriverManager.getConnection(url); var statement = connection.createStatement()) {
            statement.execute("CREATE TABLE ma_session_principal (id BIGINT)");
        }
        try (var context = start("--qwen.managed-agent.datasource.url=" + url)) {
            assertUnavailable(context.getBean(ManagedAgentService.class))
                    .hasRootCauseInstanceOf(SQLException.class)
                    .hasStackTraceContaining("must contain exactly");
            assertThat(context.getBean(TransactionalHostBean.class).value()).isEqualTo("host");
        }
    }

    @Test
    void usesDeploymentManagedSchemaWithoutInitializingIt() {
        try (var context = new SpringApplication(Host.class, Supplied.class)
                .setWebApplicationType(WebApplicationType.NONE)
                .run("--qwen.managed-agent.enabled=true", "--qwen.managed-agent.schema.initialize-enabled=false")) {
            assertNormalSessionRead(context);
            assertThat(ManagedSchema.schemaVersion(context.getBean("managedAgentDataSource", DataSource.class))).isEqualTo(1);
        }
    }

    @Test
    void callsAfterShutdownRejectWithoutRawContextFailure() {
        ManagedAgentService service;
        try (var context = start("--qwen.managed-agent.datasource.url=" + url())) {
            service = context.getBean(ManagedAgentService.class);
        }
        assertThatThrownBy(() -> service.getPublicSession(
                new com.alibaba.qwen.code.managedagent.model.SessionPrincipal("tenant", "owner", null), "missing"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Embedded Managed Agent is unavailable");
    }

    private static ConfigurableApplicationContext start(String... arguments) {
        String[] enabled = new String[arguments.length + 1];
        enabled[0] = "--qwen.managed-agent.enabled=true";
        System.arraycopy(arguments, 0, enabled, 1, arguments.length);
        return new SpringApplication(Host.class).setWebApplicationType(WebApplicationType.NONE).run(enabled);
    }

    private static void assertNormalSessionRead(org.springframework.context.ApplicationContext context) {
        var consumer = context.getBean(HostConsumer.class);
        assertThat(consumer.service()).isSameAs(context.getBean(ManagedAgentService.class));
        assertThatThrownBy(() -> consumer.service().getPublicSession(
                new com.alibaba.qwen.code.managedagent.model.SessionPrincipal("tenant", "owner", null), "missing"))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(404);
                    assertThat(error.getCode()).isEqualTo("session_not_found");
                });
    }

    private static org.assertj.core.api.AbstractThrowableAssert<?, ?> assertUnavailable(ManagedAgentService service) {
        return assertThatThrownBy(() -> service.getPublicSession(
                new com.alibaba.qwen.code.managedagent.model.SessionPrincipal("tenant", "owner", null), "missing"))
                .isInstanceOf(IllegalStateException.class);
    }

    private static String url() {
        return "jdbc:h2:mem:starter-" + UUID.randomUUID() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration
    static class Host {
        @Bean
        TransactionalHostBean transactionalHostBean() {
            return new TransactionalHostBean();
        }

        @Bean
        HostConsumer hostConsumer(
                @Qualifier("managedAgentService") ManagedAgentService service,
                @Qualifier("managedDefinitionPreparationService") ManagedAgentDefinitionPreparation definitions,
                @Qualifier("managedAgentBootstrapPreparationService") ManagedAgentBootstrapPreparation bootstraps) {
            return new HostConsumer(service, definitions, bootstraps);
        }
    }

    record HostConsumer(ManagedAgentService service, ManagedAgentDefinitionPreparation definitions,
            ManagedAgentBootstrapPreparation bootstraps) {
    }

    static class TransactionalHostBean {
        @Transactional
        public String value() {
            return "host";
        }
    }

    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class Supplied {
        @Bean(name = "managedAgentDataSource", defaultCandidate = false, destroyMethod = "close")
        DataSource dataSource() {
            var source = new DruidDataSource();
            source.setUrl(url());
            source.setValidationQuery("SELECT 1");
            ManagedSchema.initialize(source);
            return source;
        }
    }
}
