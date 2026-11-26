package com.alibaba.qwen.code.maintenance;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedDataSourceDefaults;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.context.annotation.Bean;
import org.springframework.core.env.Environment;

/** Separate Boot configuration so maintenance cannot component-scan the service. */
@SpringBootConfiguration
@EnableAutoConfiguration(exclude = FlywayAutoConfiguration.class)
@EnableConfigurationProperties(ManagedAgentProperties.class)
public class WorkspaceRecoveryApplication {
    @Bean(destroyMethod = "close")
    DruidDataSource dataSource(Environment environment) {
        var source = new DruidDataSource();
        source.setMaxActive(20);
        source.setMaxWait(30_000);
        source.setValidationQuery("SELECT 1");
        var binder = Binder.get(environment);
        binder.bind("spring.datasource",
                Bindable.ofInstance(source));
        // Bound here, not through @ConfigurationProperties, so the statement cache
        // defaults see the final URL and connection properties, as the standalone pool.
        binder.bind("spring.datasource.druid",
                Bindable.ofInstance(source));
        ManagedDataSourceDefaults.applyMySqlDefaults(source);
        return source;
    }
}
