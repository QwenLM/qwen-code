package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.ParkedMcpOwners;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ParkedMcpReclamationJobTest {
    private static final Duration IDLE = Duration.ofMinutes(30);

    private final List<ParkedMcpOwners.Owner> rows = new ArrayList<>();
    private final Map<String, Duration> sealedFor = new HashMap<>();
    private final List<String> reclaimed = new ArrayList<>();
    private final List<BooleanSupplier> guards = new ArrayList<>();
    private CompletableFuture<Boolean> outcome = CompletableFuture.completedFuture(true);

    private final ParkedMcpOwners owners = new ParkedMcpOwners() {
        @Override
        public List<Owner> candidates(long afterId, int limit) {
            return rows.stream().filter(row -> row.id() > afterId).limit(limit).toList();
        }

        @Override
        public boolean parked(Owner owner, Duration idle) {
            Duration sealed = sealedFor.get(owner.runtimeSessionId());
            return sealed != null && sealed.compareTo(idle) >= 0;
        }
    };

    private final RuntimeBrokerOperations broker = (RuntimeBrokerOperations) Proxy.newProxyInstance(
            RuntimeBrokerOperations.class.getClassLoader(), new Class<?>[] {RuntimeBrokerOperations.class},
            (proxy, method, arguments) -> {
                assertEquals("reclaimParkedMcp", method.getName());
                reclaimed.add((String) arguments[2]);
                guards.add((BooleanSupplier) arguments[3]);
                return outcome;
            });

    private ParkedMcpReclamationJob job(int batchSize) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().getMcpParking().setIdleDuration(IDLE);
        properties.getRuntimeBroker().getMcpParking().setBatchSize(batchSize);
        return new ParkedMcpReclamationJob(owners, broker, properties);
    }

    private void owner(long id, String name, Duration sealed) {
        rows.add(new ParkedMcpOwners.Owner(id, "tenant", "session-" + name, "binding", 1, name, "storage-" + name));
        if (sealed != null) {
            sealedFor.put(name, sealed);
        }
    }

    @Test
    void reclaimsOnlyOwnersSealedForTheIdlePeriod() {
        owner(1, "idle", IDLE);
        owner(2, "recent", Duration.ofMinutes(1));
        owner(3, "resident", null);
        assertEquals(new ParkedMcpReclamationJob.Sweep(3, 2, 1), job(10).runOnce());
        assertEquals(List.of("idle"), reclaimed);
    }

    @Test
    void rechecksTheSealThroughTheBrokerGuard() {
        owner(1, "idle", IDLE);
        job(10).runOnce();
        assertTrue(guards.getFirst().getAsBoolean());
        sealedFor.remove("idle");
        assertFalse(guards.getFirst().getAsBoolean());
    }

    @Test
    void expeditesOneTickForStorageThatMaintenanceIsWaitingOn() {
        owner(1, "waited-on", Duration.ofMinutes(1));
        owner(2, "other", Duration.ofMinutes(1));
        ParkedMcpReclamationJob job = job(10);
        job.expedite("storage-waited-on");
        assertEquals(1, job.runOnce().reclaimed());
        assertEquals(List.of("waited-on"), reclaimed);
        reclaimed.clear();
        assertEquals(0, job.runOnce().reclaimed());
        assertEquals(List.of(), reclaimed);
    }

    @Test
    void aRefusedOwnerDoesNotStopTheScan() {
        owner(1, "refused", IDLE);
        owner(2, "next", IDLE);
        outcome = CompletableFuture.failedFuture(new IllegalStateException("pending work"));
        assertEquals(0, job(10).runOnce().reclaimed());
        assertEquals(List.of("refused", "next"), reclaimed);
    }

    @Test
    void walksPastABatchAndWrapsAround() {
        owner(1, "first", IDLE);
        owner(2, "second", IDLE);
        owner(3, "third", IDLE);
        ParkedMcpReclamationJob job = job(2);
        job.runOnce();
        assertEquals(List.of("first", "second"), reclaimed);
        reclaimed.clear();
        job.runOnce();
        assertEquals(List.of("third"), reclaimed);
        reclaimed.clear();
        job.runOnce();
        assertEquals(List.of("first", "second"), reclaimed);
    }
}
