package example;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.api.TenantContextFilter;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.Test;
import org.springframework.aop.support.AopUtils;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.RestController;

import javax.sql.DataSource;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class StarterHostTest {
    @Test
    void startsWithoutExplicitImport() {
        var application = new SpringApplication(Host.class);
        application.setWebApplicationType(org.springframework.boot.WebApplicationType.NONE);
        try (var context = application.run("--qwen.managed-agent.enabled=true", "--qwen.managed-agent.datasource.url=" + url())) {
            assertThat(context.getBean(ManagedAgentService.class)).isNotNull();
            assertThat(AopUtils.isAopProxy(context.getBean(TransactionalHostBean.class))).isTrue();
            assertThat(context.containsBean("managedAgentExecutor")).isTrue();
            assertThat(context.getBeansWithAnnotation(RestController.class)).isEmpty();
            assertThat(context.getBeansOfType(TenantContextFilter.class)).isEmpty();
            assertThat(context.getBean("managedJdbcTemplate", JdbcTemplate.class)
                    .queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isZero();
        }
    }

    @Test
    void usesDeploymentManagedSchemaWithoutInitializingIt() {
        var application = new SpringApplication(Host.class, Supplied.class);
        application.setWebApplicationType(org.springframework.boot.WebApplicationType.NONE);
        try (var context = application.run("--qwen.managed-agent.enabled=true",
                "--qwen.managed-agent.schema.initialize-enabled=false")) {
            assertThat(context.getBean(ManagedAgentService.class)).isNotNull();
            assertThat(context.getBean("managedJdbcTemplate", JdbcTemplate.class).getDataSource())
                    .isSameAs(context.getBean("managedAgentDataSource"));
            assertThat(ManagedSchema.schemaVersion(context.getBean("managedAgentDataSource", DataSource.class))).isEqualTo(1);
        }
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
