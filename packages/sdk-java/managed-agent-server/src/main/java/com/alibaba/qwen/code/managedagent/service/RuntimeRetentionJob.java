package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeRetention;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;

public final class RuntimeRetentionJob {
    private static final Logger LOG = LoggerFactory.getLogger(RuntimeRetentionJob.class);
    private final JdbcRuntimeRetention retention;
    private final ManagedAgentProperties.RuntimeBroker.Retention settings;
    private JdbcRuntimeRetention.Cursor cursor;

    public RuntimeRetentionJob(JdbcRuntimeRetention retention, ManagedAgentProperties properties) {
        this.retention = retention;
        this.settings = properties.getRuntimeBroker().getRetention();
    }

    @Scheduled(scheduler = "runtimeRetentionScheduler",
            fixedDelayString = "${qwen.managed-agent.runtime-broker.retention.scan-delay:1m}")
    public synchronized void tick() {
        long started = System.nanoTime();
        try {
            var result = runOnce();
            LOG.info("runtime_retention bindings_scanned={} children_scanned={} skipped={}"
                            + " executions_deleted={} sessions_deleted={} bindings_deleted={} duration_ms={}",
                    result.bindingsScanned(), result.childrenScanned(), result.skipped(),
                    result.executionsDeleted(), result.sessionsDeleted(), result.bindingsDeleted(),
                    (System.nanoTime() - started) / 1_000_000);
        } catch (RuntimeException error) {
            LOG.warn("Runtime retention failed; retrying on the next scheduled tick", error);
        }
    }

    public synchronized JdbcRuntimeRetention.BatchResult runOnce() {
        var result = retention.sweep(settings.getMaxAge(), settings.getBatchSize(), cursor);
        cursor = result.cursor();
        return result;
    }
}
