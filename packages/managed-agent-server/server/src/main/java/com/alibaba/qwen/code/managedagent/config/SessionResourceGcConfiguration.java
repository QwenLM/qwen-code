package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.adapters.event.RocketMqSessionResourceGc;
import com.alibaba.qwen.code.managedagent.persistence.SessionResourceCollectionCollector;
import com.alibaba.qwen.code.managedagent.session.SessionResourceGcWakeup;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.task.ThreadPoolTaskSchedulerBuilder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.transaction.PlatformTransactionManager;

import java.io.Closeable;
import java.io.IOException;
import java.time.Duration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "qwen.managed-agent.session-resource-gc", name = "enabled", havingValue = "true")
public class SessionResourceGcConfiguration {
    @Bean(defaultCandidate = false)
    public ThreadPoolTaskScheduler managedSessionResourceGcScheduler(ThreadPoolTaskSchedulerBuilder builder) {
        return builder.poolSize(2).threadNamePrefix("managed-session-resource-gc-").build();
    }

    @Bean
    @ConditionalOnProperty(prefix = "qwen.managed-agent.session-resource-gc", name = "worker-enabled",
            havingValue = "true", matchIfMissing = true)
    Polling sessionResourceGcPolling(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager,
            ManagedAgentProperties properties) {
        return new Polling(SessionResourceCollectionCollector.mysqlOnly(jdbc, manager, properties));
    }

    @Bean
    Dispatch sessionResourceGcDispatch(ManagedAgentProperties properties, ObjectProvider<Polling> workers) {
        var storage = properties.getSessionResources();
        if (properties.getToolPublication().isEnabled() || storage.isEnabled()
                || storage.isPackJobEnabled() || storage.isDeletionEnabled()) {
            throw new IllegalStateException("MySQL Session resource GC requires external Session resources and tool publication to be disabled");
        }
        var gc = properties.getSessionResourceGc();
        if (StringUtils.isAllBlank(gc.getEndpoints(), gc.getTopic(), gc.getConsumerGroup())) {
            return new Dispatch(null, properties.getToolPublication().getDeletionGrace());
        }
        if (StringUtils.isAnyBlank(gc.getEndpoints(), gc.getTopic(), gc.getConsumerGroup())) {
            throw new IllegalStateException("Session resource GC MQ requires endpoints, topic and consumer-group");
        }
        var events = properties.getEventTransport();
        if (events.isEnabled() && gc.getTopic().equals(events.getTopic())) {
            throw new IllegalStateException("Session resource GC MQ requires a dedicated delay topic");
        }
        Polling polling = workers.getIfAvailable();
        var transport = new RocketMqSessionResourceGc(gc.getEndpoints(), gc.getTopic(), gc.getConsumerGroup(),
                polling == null ? null : polling.collector()::wake);
        return new Dispatch(transport, properties.getToolPublication().getDeletionGrace());
    }

    record Polling(SessionResourceCollectionCollector collector) {
        @Scheduled(fixedDelay = 1000, scheduler = "managedSessionResourceGcScheduler")
        public void poll() {
            collector.tick();
        }
    }

    record Dispatch(RocketMqSessionResourceGc transport, Duration grace) implements SessionResourceGcWakeup, Closeable {
        @Scheduled(fixedDelay = 30000, scheduler = "managedSessionResourceGcScheduler")
        public void connect() {
            if (transport != null) {
                transport.connect();
            }
        }

        @Override
        public void retired(String tenant, String session) {
            if (transport != null) {
                transport.publish(tenant, session, grace);
            }
        }

        @Override
        public void close() throws IOException {
            if (transport != null) {
                transport.close();
            }
        }
    }
}
