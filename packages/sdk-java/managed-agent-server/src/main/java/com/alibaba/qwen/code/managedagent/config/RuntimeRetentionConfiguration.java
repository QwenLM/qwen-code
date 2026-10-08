package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.service.RuntimeRetentionJob;
import com.alibaba.qwen.code.managedagent.store.ManagedRuntimeRetentionGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeRetention;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import javax.sql.DataSource;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
        name = {"enabled", "retention.enabled"}, havingValue = "true")
public class RuntimeRetentionConfiguration {
    @Bean
    public ThreadPoolTaskScheduler runtimeRetentionScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("runtime-retention-").build();
    }

    @Bean
    public RuntimeRetentionJob runtimeRetentionJob(DataSource source,
            RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            ToolExecutionRepository executions, ManagedAgentProperties properties) {
        if (!(bindings instanceof JdbcRuntimeBindingRepository jdbcBindings)
                || !(sessions instanceof JdbcRuntimeSessionRepository jdbcSessions)
                || !(executions instanceof JdbcToolExecutionRepository jdbcExecutions)
                || !jdbcBindings.usesDataSource(source) || !jdbcSessions.usesDataSource(source)
                || !jdbcExecutions.usesDataSource(source)) {
            throw new IllegalStateException("Runtime retention requires native JDBC repositories on one DataSource");
        }
        return new RuntimeRetentionJob(new JdbcRuntimeRetention(source, jdbcBindings,
                new ManagedRuntimeRetentionGuard()), properties);
    }
}
