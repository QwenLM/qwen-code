package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import javax.sql.DataSource;

@Configuration(proxyBeanMethods = false)
public class ManagedAgentPersistenceConfiguration {
    @Bean(defaultCandidate = false, destroyMethod = "close")
    @ConditionalOnMissingBean(name = "managedAgentDataSource")
    DruidDataSource managedAgentDataSource(Environment environment) {
        String prefix = "qwen.managed-agent.datasource.";
        String url = environment.getProperty(prefix + "url");
        if (StringUtils.isBlank(url)) {
            throw new IllegalStateException("qwen.managed-agent.datasource.url or a named managedAgentDataSource is required");
        }
        var source = new DruidDataSource();
        source.setUrl(url);
        source.setUsername(environment.getProperty(prefix + "username"));
        source.setPassword(environment.getProperty(prefix + "password"));
        source.setMaxActive(environment.getProperty(prefix + "max-active", Integer.class, 20));
        source.setMaxWait(30_000);
        source.setValidationQuery("SELECT 1");
        return source;
    }

    @Bean(defaultCandidate = false)
    JdbcTemplate managedJdbcTemplate(@Qualifier("managedAgentDataSource") DataSource source) {
        ManagedSchema.initialize(source);
        return new ManagedSchemaJdbcTemplate(source);
    }

    @Bean(defaultCandidate = false)
    DataSourceTransactionManager managedAgentTransactionManager(
            @Qualifier("managedAgentDataSource") DataSource source,
            @Qualifier("managedJdbcTemplate") JdbcTemplate initialized) {
        return new DataSourceTransactionManager(source);
    }

    @Bean(defaultCandidate = false)
    ObjectMapper managedAgentObjectMapper() {
        return Jackson2ObjectMapperBuilder.json().build();
    }
}
