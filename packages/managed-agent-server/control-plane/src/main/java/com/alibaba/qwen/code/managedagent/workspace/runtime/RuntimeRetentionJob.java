package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeRetention;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;

public final class RuntimeRetentionJob {
    private static final Logger LOG = LoggerFactory.getLogger(RuntimeRetentionJob.class);
    private final RuntimeRetention retention;
    private final ManagedAgentSettings.RuntimeBroker.Retention settings;
    private RuntimeRetention.Cursor cursor;

    public RuntimeRetentionJob(RuntimeRetention retention, ManagedAgentSettings properties) {
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

    public synchronized RuntimeRetention.BatchResult runOnce() {
        var result = retention.sweep(settings.getMaxAge(), settings.getBatchSize(), cursor);
        cursor = result.cursor();
        return result;
    }
}
