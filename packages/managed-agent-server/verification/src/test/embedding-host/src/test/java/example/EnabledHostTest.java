package example;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentConfiguration;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class EnabledHostTest {
    @Test
    void startsOwnedPoolThroughOrdinaryDependency() {
        var application = new SpringApplication(Host.class);
        application.setWebApplicationType(WebApplicationType.NONE);
        try (var context = application.run("--qwen.managed-agent.datasource.url=" + url())) {
            assertThat(context.getBean(ManagedAgentService.class)).isNotNull();
            assertThat(context.getBean("managedJdbcTemplate", JdbcTemplate.class)
                    .queryForObject("SELECT COUNT(*) FROM ma_agent_definition", Integer.class)).isZero();
        }
    }

    @Test
    void startsWithExplicitHostPoolThroughOrdinaryDependency() {
        var application = new SpringApplication(Host.class, Supplied.class);
        application.setWebApplicationType(WebApplicationType.NONE);
        try (var context = application.run()) {
            assertThat(context.getBean(ManagedAgentService.class)).isNotNull();
            assertThat(context.getBean("managedJdbcTemplate", JdbcTemplate.class).getDataSource())
                    .isSameAs(context.getBean("managedAgentDataSource"));
        }
    }

    private static String url() {
        return "jdbc:h2:mem:dependency-" + UUID.randomUUID() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    }

    @SpringBootConfiguration
    @EnableAutoConfiguration
    @Import(ManagedAgentConfiguration.class)
    static class Host {
    }

    @org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
    static class Supplied {
        @Bean(name = "managedAgentDataSource", defaultCandidate = false, destroyMethod = "close")
        DataSource dataSource() {
            var source = new DruidDataSource();
            source.setUrl(url());
            source.setValidationQuery("SELECT 1");
            return source;
        }
    }
}
