package com.alibaba.qwen.code.managedagent;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentConfiguration;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentWebConfiguration;
import com.alibaba.qwen.code.managedagent.config.ManagedLocalConfiguration;
import com.alibaba.qwen.code.managedagent.preflight.ManagedAgentPreflight;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Profile;

import java.util.Arrays;

@SpringBootConfiguration
@org.springframework.boot.context.properties.EnableConfigurationProperties(org.springframework.boot.autoconfigure.jdbc.DataSourceProperties.class)
@EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
@Import({ManagedAgentConfiguration.class, ManagedAgentWebConfiguration.class, ManagedLocalConfiguration.class})
public class ManagedAgentServerApplication {
    @Bean
    FlywayMigrationStrategy freshManagedSchema(
            @org.springframework.beans.factory.annotation.Qualifier("managedAgentDataSource") javax.sql.DataSource source) {
        return new com.alibaba.qwen.code.managedagent.config.ManagedSchemaConfiguration().freshManagedSchema(source);
    }

    @Bean(name = "managedAgentDataSource", destroyMethod = "close")
    @Profile("!managed-local")
    @ConfigurationProperties("spring.datasource.druid")
    DruidDataSource standaloneDataSource(org.springframework.core.env.Environment environment) {
        var source = new DruidDataSource();
        source.setMaxActive(20);
        source.setMaxWait(30_000);
        source.setValidationQuery("SELECT 1");
        org.springframework.boot.context.properties.bind.Binder.get(environment).bind(
                "spring.datasource", org.springframework.boot.context.properties.bind.Bindable.ofInstance(source));
        return source;
    }

    public static void main(String[] args) {
        if (Arrays.asList(args).contains("--check")) {
            System.exit(ManagedAgentPreflight.run(args));
        }
        SpringApplication.run(ManagedAgentServerApplication.class, args);
    }
}
