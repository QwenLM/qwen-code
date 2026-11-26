package com.alibaba.qwen.code.managedagent;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentConfiguration;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentWebConfiguration;
import com.alibaba.qwen.code.managedagent.config.ManagedDataSourceDefaults;
import com.alibaba.qwen.code.managedagent.config.ManagedLocalConfiguration;
import com.alibaba.qwen.code.managedagent.config.ManagedSchemaConfiguration;
import com.alibaba.qwen.code.managedagent.preflight.ManagedAgentPreflight;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.boot.autoconfigure.jdbc.DataSourceProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;

import javax.sql.DataSource;

import java.util.Arrays;

@SpringBootConfiguration
@EnableConfigurationProperties(DataSourceProperties.class)
@EnableAutoConfiguration(exclude = DataSourceAutoConfiguration.class)
@Import({ManagedAgentConfiguration.class, ManagedAgentWebConfiguration.class, ManagedLocalConfiguration.class})
public class ManagedAgentServerApplication {
    @Bean
    FlywayMigrationStrategy freshManagedSchema(
            @Qualifier("managedAgentDataSource") DataSource source) {
        return new ManagedSchemaConfiguration().freshManagedSchema(source);
    }

    @Bean(name = "managedAgentDataSource", destroyMethod = "close")
    @Profile("!managed-local")
    DruidDataSource standaloneDataSource(Environment environment) {
        var source = new DruidDataSource();
        source.setMaxActive(20);
        source.setMaxWait(30_000);
        source.setValidationQuery("SELECT 1");
        var binder = Binder.get(environment);
        binder.bind("spring.datasource", Bindable.ofInstance(source));
        // Bound here, not through @ConfigurationProperties, which binds only after
        // this method returns: the statement cache defaults must see the final URL
        // and connection properties.
        binder.bind("spring.datasource.druid", Bindable.ofInstance(source));
        ManagedDataSourceDefaults.applyMySqlDefaults(source);
        return source;
    }

    public static void main(String[] args) {
        if (Arrays.asList(args).contains("--check")) {
            System.exit(ManagedAgentPreflight.run(args));
        }
        SpringApplication.run(ManagedAgentServerApplication.class, args);
    }
}
