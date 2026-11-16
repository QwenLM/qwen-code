package com.alibaba.qwen.code.maintenance;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedDataSourceDefaults;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayAutoConfiguration;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/** Separate Boot configuration so maintenance cannot component-scan the service. */
@SpringBootConfiguration
@EnableAutoConfiguration(exclude = FlywayAutoConfiguration.class)
@EnableConfigurationProperties(ManagedAgentProperties.class)
public class WorkspaceRecoveryApplication {
    @org.springframework.context.annotation.Bean(destroyMethod = "close")
    com.alibaba.druid.pool.DruidDataSource dataSource(org.springframework.core.env.Environment environment) {
        var source = new com.alibaba.druid.pool.DruidDataSource();
        source.setMaxActive(20);
        source.setMaxWait(30_000);
        source.setValidationQuery("SELECT 1");
        var binder = org.springframework.boot.context.properties.bind.Binder.get(environment);
        binder.bind("spring.datasource",
                org.springframework.boot.context.properties.bind.Bindable.ofInstance(source));
        // Bound here, not through @ConfigurationProperties, so the statement cache
        // defaults see the final URL and connection properties, as the standalone pool.
        binder.bind("spring.datasource.druid",
                org.springframework.boot.context.properties.bind.Bindable.ofInstance(source));
        ManagedDataSourceDefaults.applyMySqlDefaults(source);
        return source;
    }
}
