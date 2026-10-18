package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.ForkJoinTask;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

@DisabledOnOs(OS.WINDOWS)
class LocalProcessStopExecutorTest {
    @TempDir
    Path directory;

    @Test
    void drainedStopCompletesWhenTheCommonPoolIsBusy() throws Exception {
        var pool = ForkJoinPool.commonPool();
        int parallelism = pool.getParallelism();
        assumeTrue(parallelism > 1, "CompletableFuture uses separate threads below parallelism two");
        var host = new LocalRuntimeStore.HostIdentity("a".repeat(32),
                "11111111-1111-1111-1111-111111111111", "pid:[1]", "time:[1]");
        var store = new LocalRuntimeStore(directory.toRealPath(), host);
        var scope = new RuntimeScope("tenant", "workspace", "1", directory.toAbsolutePath().toString(),
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        var request = new RuntimeProvisionRequest(scope, "harness", LocalProcessRuntimeProvisioner.KIND,
                "storage:a");
        var seed = RuntimeProvisionSeed.create("binding", 1);
        var started = new CountDownLatch(parallelism);
        var release = new CountDownLatch(1);
        List<ForkJoinTask<?>> blockers = new ArrayList<>();
        CompletableFuture<RuntimeDrainReceipt> stopped = null;
        try (var provider = new LocalProcessRuntimeProvisioner(List.of("unused"), directory,
                new HttpRuntimeTransport(), ignored -> "storage:a", store)) {
            var handle = provider.ensureResource(request, seed, null).toCompletableFuture().get(5, TimeUnit.SECONDS);
            var binding = new RuntimeBindingRecord("binding", request, seed, 1, RuntimeBindingRecord.State.DRAINING,
                    null, handle, 0, true, null, null, 0, 0, null, Instant.now(), Instant.now());
            for (int index = 0; index < parallelism; index++) {
                blockers.add(pool.submit(() -> {
                    started.countDown();
                    try {
                        release.await();
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(error);
                    }
                }));
            }
            assertTrue(started.await(10, TimeUnit.SECONDS), "common-pool workers did not enter the fixture");
            assertEquals(handle, provider.ensureResource(request, seed, handle)
                    .toCompletableFuture().get(2, TimeUnit.SECONDS));
            stopped = provider.stopDrained(binding).toCompletableFuture();
            assertTrue(stopped.get(2, TimeUnit.SECONDS).matches(binding));
            assertEquals(LocalRuntimeStore.State.RETIRED, store.locked(request, seed, handle, false,
                    (resource, registration) -> registration.state()));
        } finally {
            release.countDown();
            for (var blocker : blockers) {
                blocker.get(5, TimeUnit.SECONDS);
            }
            if (stopped != null) {
                stopped.get(5, TimeUnit.SECONDS);
            }
        }
    }
}
