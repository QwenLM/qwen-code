package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.persistence.JdbcParkedMcpOwners;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.workspace.runtime.ParkedMcpReclamationJob;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
        name = {"enabled", "mcp-parking.enabled"}, havingValue = "true")
public class ParkedMcpReclamationConfiguration {
    @Bean(defaultCandidate = false)
    public ThreadPoolTaskScheduler parkedMcpReclamationScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("parked-mcp-reclamation-").build();
    }

    @Bean
    public ParkedMcpReclamationJob parkedMcpReclamationJob(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            RuntimeBrokerService broker, JdbcWorkspaceExecutionStore executionStore,
            ManagedAgentProperties properties) {
        var job = new ParkedMcpReclamationJob(new JdbcParkedMcpOwners(jdbc), broker, properties);
        executionStore.onMaintenanceBusy(job::expedite);
        broker.enableMcpParking();
        return job;
    }
}
