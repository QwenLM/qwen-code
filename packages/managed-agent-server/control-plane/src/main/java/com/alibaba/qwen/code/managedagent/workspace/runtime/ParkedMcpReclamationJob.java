package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.ParkedMcpOwners;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;

import java.time.Duration;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;

/** Retires MCP connections of Sessions suspended for the configured idle period. */
public final class ParkedMcpReclamationJob {
    private static final Logger LOG = LoggerFactory.getLogger(ParkedMcpReclamationJob.class);

    /** What one tick found among the owners it examined. */
    public record Sweep(int scanned, int parked, int reclaimed) {
    }

    private final ParkedMcpOwners owners;
    private final RuntimeBrokerOperations broker;
    private final ManagedAgentSettings.RuntimeBroker.McpParking settings;
    private final Set<String> expedited = ConcurrentHashMap.newKeySet();
    private long cursor;

    public ParkedMcpReclamationJob(ParkedMcpOwners owners, RuntimeBrokerOperations broker,
            ManagedAgentSettings properties) {
        this.owners = owners;
        this.broker = broker;
        this.settings = properties.getRuntimeBroker().getMcpParking();
    }

    /** Reclaims this storage's parked owners on the next tick, whatever their idle time. */
    public void expedite(String storageKey) {
        expedited.add(storageKey);
    }

    @Scheduled(scheduler = "parkedMcpReclamationScheduler",
            fixedDelayString = "${qwen.managed-agent.runtime-broker.mcp-parking.scan-delay:1m}")
    public void tick() {
        try {
            Sweep sweep = runOnce();
            LOG.info("parked_mcp_reclamation scanned={} parked={} reclaimed={}",
                    sweep.scanned(), sweep.parked(), sweep.reclaimed());
        } catch (RuntimeException error) {
            LOG.warn("Parked MCP reclamation failed; retrying on the next scheduled tick", error);
        }
    }

    public synchronized Sweep runOnce() {
        var candidates = owners.candidates(cursor, settings.getBatchSize());
        cursor = candidates.size() < settings.getBatchSize() ? 0 : candidates.getLast().id();
        Set<String> urgent = new HashSet<>(expedited);
        expedited.removeAll(urgent);
        int parked = 0;
        int reclaimed = 0;
        for (var owner : candidates) {
            if (!owners.parked(owner, Duration.ZERO)) {
                continue;
            }
            parked++;
            boolean due = urgent.contains(owner.storageKey()) || owners.parked(owner, settings.getIdleDuration());
            if (due && reclaim(owner)) {
                reclaimed++;
            }
        }
        return new Sweep(candidates.size(), parked, reclaimed);
    }

    private boolean reclaim(ParkedMcpOwners.Owner owner) {
        try {
            return broker.reclaimParkedMcp(owner.bindingId(), owner.generation(), owner.runtimeSessionId(),
                    () -> owners.parked(owner, Duration.ZERO)).toCompletableFuture().join();
        } catch (CompletionException error) {
            // Pending work or a reopened Session refuses; the next tick looks again.
            LOG.debug("Parked MCP owner {} was not reclaimed", owner.runtimeSessionId(), error);
            return false;
        }
    }
}
