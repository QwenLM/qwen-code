package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.SessionResourceCollectionCollector;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationCollector;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationRetentionObserver;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationRetentionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import org.apache.commons.lang3.StringUtils;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.transaction.PlatformTransactionManager;

@Configuration
@ConditionalOnProperty(prefix = "qwen.managed-agent.tool-publication",
        name = "enabled", havingValue = "true")
public class ToolPublicationConfiguration {
    @Bean
    public ToolPublicationStore toolPublicationStore(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ManagedSessionStore sessions,
            ToolExecutionRepository executions, RuntimeBindingRepository bindings,
            ManagedAgentProperties properties) {
        var settings = properties.getToolPublication();
        required(settings.getServiceBaseUrl(), "publication service URL");
        var capacity = new ToolPublicationStore.Capacity(
                required(settings.getExecutionBytes(), "execution byte capacity"),
                required(settings.getSessionBytes(), "Session byte capacity"),
                required(settings.getTenantBytes(), "tenant byte capacity"),
                required(settings.getActiveCaptures(), "active capture capacity"));
        if (settings.getEntryConcurrency() == null || settings.getEntryConcurrency() < 1) {
            throw new IllegalStateException("Tool publication entry concurrency is required");
        }
        return new ToolPublicationStore(jdbc, manager, sessions, executions,
                bindings, capacity, settings.isJournalHeadAuthorization());
    }

    @Bean
    public ToolPublicationDataStore toolPublicationDataStore(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ToolPublicationStore grants,
            ManagedSessionStore sessions, ToolPublicationObjectStore objects,
            ManagedAgentProperties properties) {
        var settings = properties.getToolPublication();
        if (settings.isAsyncVerificationEnabled() && !settings.isJournalHeadAuthorization()) {
            throw new IllegalStateException("Async verification requires journal-head authorization");
        }
        if (settings.getOperationTimeout() == null || settings.getClaimTimeout() == null
                || settings.getMaxVerificationTimeout() == null) {
            throw new IllegalStateException("Tool publication operation and verification deadlines are required");
        }
        var budget = new ToolPublicationDataStore.VerificationBudget(
                required(settings.getVerificationBytesPerSecond(), "verification throughput floor"),
                settings.getMaxVerificationTimeout());
        budget.timeout(settings.getOperationTimeout(), Math.addExact(
                required(settings.getExecutionBytes(), "execution byte capacity"), ToolPublicationContract.PRODUCER_BYTES));
        return new ToolPublicationDataStore(jdbc, manager, grants, sessions, objects,
                settings.getOperationTimeout(), settings.getClaimTimeout(), budget);
    }

    @Bean
    public ToolPublicationAdmissionStore toolPublicationAdmissionStore(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ManagedSessionStore sessions,
            ToolPublicationDataStore data) {
        return new ToolPublicationAdmissionStore(jdbc, manager, sessions, data);
    }

    @Bean
    public ToolPublicationRetentionStore toolPublicationRetentionStore(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ManagedAgentProperties properties) {
        var grace = properties.getToolPublication().getDeletionGrace();
        if (grace == null || grace.isNegative()) {
            throw new IllegalStateException("Tool output deletion grace must be nonnegative");
        }
        return new ToolPublicationRetentionStore(jdbc, manager);
    }

    @Bean
    public ToolPublicationRetentionObserver toolPublicationRetentionObserver(ToolPublicationRetentionStore retention,
            ManagedAgentProperties properties) {
        return new ToolPublicationRetentionObserver(retention, properties);
    }

    @Bean
    public ThreadPoolTaskScheduler managedToolOutputScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("managed-tool-output-").build();
    }

    @Bean
    public ThreadPoolTaskScheduler managedToolVerificationScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(1).threadNamePrefix("managed-tool-verification-scan-").build();
    }

    // Rollback disables new async admission; accepted operations must still drain.
    @Bean(destroyMethod = "close")
    public ToolPublicationVerifier toolPublicationVerifier(ToolPublicationDataStore data,
            ManagedAgentProperties properties) {
        return new ToolPublicationVerifier(data, properties.getToolPublication().getVerificationConcurrency());
    }

    @Bean
    public ToolPublicationCollector toolPublicationCollector(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ToolPublicationRetentionStore retention, ToolPublicationObjectStore objects, ManagedAgentProperties properties) {
        return new ToolPublicationCollector(jdbc, manager, retention, objects, properties);
    }

    @Bean
    public SessionResourceCollectionCollector sessionResourceCollectionCollector(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ManagedAgentProperties properties) {
        return new SessionResourceCollectionCollector(jdbc, manager, properties);
    }

    private static String required(String value, String label) {
        if (StringUtils.isBlank(value)) {
            throw new IllegalStateException("Tool publication " + label + " is required");
        }
        return value;
    }

    private static long required(Long value, String label) {
        if (value == null || value < 1) {
            throw new IllegalStateException("Tool publication " + label + " is required");
        }
        return value;
    }
}
